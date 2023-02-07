import contextlib
import logging
import typing

from opentelemetry import trace, _logs
from opentelemetry._logs.severity import std_to_otel
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.logging import LoggingInstrumentor
from opentelemetry.sdk._logs import LoggerProvider, LogRecord
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.trace import TracerProvider, _Span
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from highlight_io.integrations import Integration


class H(object):
    REQUEST_HEADER = "X-Highlight-Request"
    OTLP_HTTP = "https://otel.highlight.io:4318"
    _instance: "H" = None

    @classmethod
    def get_instance(cls) -> "H":
        if not cls._instance:
            raise NotImplementedError(
                "highlight_io H object is not configured, please instantiate it by calling H()"
            )
        return cls._instance

    def __init__(
        self,
        project_id: str,
        integrations: typing.List[Integration] = None,
        record_logs: bool = False,
    ):
        """
        Setup Highlight backend instrumentation.

        Example:
            import highlight_io
            H = highlight_io.H('project_id', ...)


        :param project_id: a string that corresponds to the verbose id of your project from app.highlight.io/setup
        :param integrations: a list of Integrations that allow connecting with your framework, like Flask or Django.
        :param record_logs: set True if you would like python logging to be recorded as part of the session.
        :return: a configured H instance
        """
        H._instance = self
        self._project_id = project_id
        self._integrations = integrations or []
        self._record_logs = record_logs
        if self._record_logs:
            self._instrument_logs()

        self._trace_provider = TracerProvider()
        self._trace_provider.add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(f"{H.OTLP_HTTP}/v1/traces"))
        )
        trace.set_tracer_provider(self._trace_provider)
        self.tracer = trace.get_tracer(__name__)

        self._log_provider = LoggerProvider()
        self._log_provider.add_log_record_processor(
            BatchLogRecordProcessor(OTLPLogExporter(f"{H.OTLP_HTTP}/v1/logs"))
        )
        _logs.set_logger_provider(self._log_provider)
        self.log = self._log_provider.get_logger(__name__)

        for integration in self._integrations:
            integration.enable()

    @contextlib.contextmanager
    def trace(
        self,
        session_id: typing.Optional[str] = "",
        request_id: typing.Optional[str] = "",
    ) -> None:
        """
        Catch exceptions raised by your app using this context manager.
        Exceptions will be recorded with the Highlight project and
        associated with a frontend session when headers are provided.

        Example:
            import highlight_io
            H = highlight_io.H('project_id', ...)

            def my_fn():
                with H.guard(headers={'X-Highlight-Request': '...'}):
                    raise Exception('fake error!')


        :param session_id: the highlight session that initiated this network request.
        :param request_id: the identifier of the current network request.
        :return: None
        """
        with self.tracer.start_as_current_span("highlight-ctx") as span:
            span.set_attributes({"highlight_project_id": self._project_id})
            span.set_attributes({"highlight_session_id": session_id})
            span.set_attributes({"highlight_trace_id": request_id})
            try:
                yield
            except Exception as e:
                self.record_exception(e)
                raise

    @staticmethod
    def record_exception(e: Exception) -> None:
        """
        Record arbitrary exceptions raised within your app.

        Example:
            import highlight_io
            H = highlight_io.H('project_id', ...)

            def my_fn():
                try:
                    for i in range(20):
                        result = 100 / (10 - i)
                        print(f'dangerous: {result}')
                except Exception as e:
                    H.record_exception(e)


        :param e: the exception to record. the contents and stacktrace will be recorded.
        :return: None
        """
        span = trace.get_current_span()
        if not span:
            raise RuntimeError("H.record_exception called without a span context")
        span.record_exception(e)
        logging.exception("Highlight caught an error", exc_info=e)

    def _log_hook(self, span: _Span, record: logging.LogRecord):
        if span and span.is_recording():
            ctx = span.get_span_context()
            r = LogRecord(
                timestamp=int(record.created),
                trace_id=ctx.trace_id,
                span_id=ctx.span_id,
                trace_flags=ctx.trace_flags,
                severity_text=record.levelname,
                severity_number=std_to_otel(record.levelno),
                body=record.getMessage(),
                resource=span.resource,
                attributes=span.attributes,
            )
            self.log.emit(r)

    def _instrument_logs(self):
        LoggingInstrumentor().instrument(
            set_logging_format=True, log_hook=self._log_hook
        )
