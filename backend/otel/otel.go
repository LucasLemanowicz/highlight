package otel

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi"
	"github.com/google/uuid"
	"github.com/highlight-run/highlight/backend/clickhouse"
	kafkaqueue "github.com/highlight-run/highlight/backend/kafka-queue"
	model2 "github.com/highlight-run/highlight/backend/model"
	"github.com/highlight-run/highlight/backend/public-graph/graph"
	"github.com/highlight-run/highlight/backend/public-graph/graph/model"
	"github.com/highlight/highlight/sdk/highlight-go"
	hlog "github.com/highlight/highlight/sdk/highlight-go/log"
	"github.com/openlyinc/pointy"
	e "github.com/pkg/errors"
	log "github.com/sirupsen/logrus"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
	semconv "go.opentelemetry.io/otel/semconv/v1.17.0"
)

type Handler struct {
	resolver *graph.Resolver
}

func cast[T string | int64 | float64](v interface{}, fallback T) T {
	c, ok := v.(T)
	if !ok {
		return fallback
	}
	return c
}

func setHighlightAttributes(attrs map[string]any, projectID, sessionID, requestID, source *string) {
	ptrs := map[string]*string{
		highlight.DeprecatedProjectIDAttribute: projectID,
		highlight.DeprecatedSessionIDAttribute: sessionID,
		highlight.DeprecatedRequestIDAttribute: requestID,
		highlight.DeprecatedSourceAttribute:    source,
		highlight.ProjectIDAttribute:           projectID,
		highlight.SessionIDAttribute:           sessionID,
		highlight.RequestIDAttribute:           requestID,
		highlight.SourceAttribute:              source,
	}
	for _, k := range []string{
		highlight.DeprecatedProjectIDAttribute,
		highlight.DeprecatedSessionIDAttribute,
		highlight.DeprecatedRequestIDAttribute,
		highlight.DeprecatedSourceAttribute,
		highlight.ProjectIDAttribute,
		highlight.SessionIDAttribute,
		highlight.RequestIDAttribute,
		highlight.SourceAttribute,
	} {
		if p, ok := attrs[k]; ok {
			if v, _ := p.(string); v != "" {
				*ptrs[k] = v
			}
		}
	}
}

func projectToInt(projectID string) (int, error) {
	i, err := strconv.ParseInt(projectID, 10, 32)
	if err == nil {
		return int(i), nil
	}
	i2, err := model2.FromVerboseID(projectID)
	if err == nil {
		return i2, nil
	}
	return 0, e.New(fmt.Sprintf("invalid project id %s", projectID))
}

func (o *Handler) HandleTrace(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		log.WithContext(ctx).Error(err, "invalid trace body")
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	gz, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		log.WithContext(ctx).Error(err, "invalid gzip format for trace")
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	output, err := io.ReadAll(gz)
	if err != nil {
		log.WithContext(ctx).Error(err, "invalid gzip stream for trace")
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	req := ptraceotlp.NewExportRequest()
	err = req.UnmarshalProto(output)
	if err != nil {
		log.WithContext(ctx).Error(err, "invalid trace protobuf")
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var projectErrors = make(map[string][]*model.BackendErrorObjectInput)
	var traceErrors = make(map[string][]*model.BackendErrorObjectInput)

	var projectLogs = make(map[string][]*clickhouse.LogRow)

	spans := req.Traces().ResourceSpans()
	for i := 0; i < spans.Len(); i++ {
		var projectID, sessionID, requestID, source string
		resource := spans.At(i).Resource()
		resourceAttributes := resource.Attributes().AsRaw()
		hostName := cast(resource.Attributes().AsRaw()[string(semconv.HostNameKey)], "")
		serviceName := cast(resource.Attributes().AsRaw()[string(semconv.ServiceNameKey)], "")
		setHighlightAttributes(resourceAttributes, &projectID, &sessionID, &requestID, &source)
		scopeScans := spans.At(i).ScopeSpans()
		for j := 0; j < scopeScans.Len(); j++ {
			spans := scopeScans.At(j).Spans()
			for k := 0; k < spans.Len(); k++ {
				span := spans.At(k)
				spanAttributes := span.Attributes().AsRaw()
				tagsBytes, err := json.Marshal(spanAttributes)
				if err != nil {
					log.WithContext(ctx).Errorf("failed to format error attributes %s", tagsBytes)
					continue
				}
				setHighlightAttributes(spanAttributes, &projectID, &sessionID, &requestID, &source)
				events := span.Events()
				for l := 0; l < events.Len(); l++ {
					event := events.At(l)
					eventAttributes := event.Attributes().AsRaw()
					setHighlightAttributes(eventAttributes, &projectID, &sessionID, &requestID, &source)
					if event.Name() == semconv.ExceptionEventName {
						traceID := cast(requestID, span.TraceID().String())
						spanID := span.SpanID().String()
						excMessage := cast(eventAttributes[string(semconv.ExceptionMessageKey)], "")
						ts := event.Timestamp().AsTime()

						logCursor := func() *string {
							projectIDInt, err := projectToInt(projectID)
							if err != nil {
								log.WithContext(ctx).WithField("ProjectVerboseID", projectID).WithField("ExcMessage", excMessage).Errorf("otel span error got invalid project id")
								return nil
							}
							logRow := clickhouse.NewLogRow(clickhouse.LogRowPrimaryAttrs{
								Timestamp:       ts,
								ProjectId:       uint32(projectIDInt),
								TraceId:         traceID,
								SpanId:          spanID,
								SecureSessionId: sessionID,
							},
								clickhouse.WithLogAttributes(resourceAttributes, eventAttributes),
								clickhouse.WithSeverityText("ERROR"),
							)
							logRow.ServiceName = serviceName
							logRow.Body = excMessage
							if projectID != "" {
								if _, ok := projectLogs[projectID]; !ok {
									projectLogs[projectID] = []*clickhouse.LogRow{}
								}
								projectLogs[projectID] = append(projectLogs[projectID], logRow)
							} else {
								data, _ := req.MarshalJSON()
								log.WithContext(ctx).WithField("LogEvent", event).WithField("LogRow", *logRow).WithField("RequestJSON", string(data)).Errorf("otel span log got no project")
							}
							return pointy.String(logRow.Cursor())
						}()

						func() {
							excType := cast(eventAttributes[string(semconv.ExceptionTypeKey)], source)
							errorUrl := cast(eventAttributes[highlight.ErrorURLAttribute], "")
							stackTrace := cast(eventAttributes[string(semconv.ExceptionStacktraceKey)], "")
							if excType == "" && excMessage == "" {
								log.WithContext(ctx).WithField("Span", span).WithField("EventAttributes", eventAttributes).Error("otel received exception with no type and no message")
								return
							} else if stackTrace == "" || stackTrace == "null" {
								log.WithContext(ctx).WithField("Span", span).WithField("EventAttributes", eventAttributes).Warn("otel received exception with no stacktrace")
								stackTrace = ""
							}
							stackTrace = formatStructureStackTrace(ctx, stackTrace)
							err := &model.BackendErrorObjectInput{
								SessionSecureID: &sessionID,
								RequestID:       &requestID,
								TraceID:         pointy.String(traceID),
								SpanID:          pointy.String(spanID),
								LogCursor:       logCursor,
								Event:           excMessage,
								Type:            excType,
								Source:          hostName,
								StackTrace:      stackTrace,
								Timestamp:       ts,
								Payload:         pointy.String(string(tagsBytes)),
								URL:             errorUrl,
							}
							if sessionID != "" {
								if _, ok := traceErrors[sessionID]; !ok {
									traceErrors[sessionID] = []*model.BackendErrorObjectInput{}
								}
								traceErrors[sessionID] = append(traceErrors[sessionID], err)
							} else if projectID != "" {
								if _, ok := projectErrors[projectID]; !ok {
									projectErrors[projectID] = []*model.BackendErrorObjectInput{}
								}
								projectErrors[projectID] = append(projectErrors[projectID], err)
							} else {
								log.WithContext(ctx).WithField("BackendErrorObjectInput", *err).Errorf("otel error got no session and no project")
								return
							}
						}()
					} else if event.Name() == highlight.LogEvent {
						logSev := cast(eventAttributes[string(hlog.LogSeverityKey)], "unknown")
						logMessage := cast(eventAttributes[string(hlog.LogMessageKey)], "")
						if logMessage == "" {
							log.WithContext(ctx).WithField("Span", span).WithField("EventAttributes", eventAttributes).Warn("otel received log with no message")
							continue
						}
						projectIDInt, err := projectToInt(projectID)
						if err != nil {
							log.WithContext(ctx).WithField("ProjectVerboseID", projectID).WithField("LogMessage", logMessage).Errorf("otel span log got invalid project id")
							continue
						}
						logRow := clickhouse.NewLogRow(clickhouse.LogRowPrimaryAttrs{
							Timestamp:       event.Timestamp().AsTime(),
							TraceId:         cast(requestID, span.TraceID().String()),
							SpanId:          span.SpanID().String(),
							ProjectId:       uint32(projectIDInt),
							SecureSessionId: sessionID,
						},
							clickhouse.WithLogAttributes(resourceAttributes, eventAttributes),
							clickhouse.WithSeverityText(logSev),
						)

						logRow.ServiceName = serviceName
						logRow.Body = logMessage
						if projectID != "" {
							if _, ok := projectLogs[projectID]; !ok {
								projectLogs[projectID] = []*clickhouse.LogRow{}
							}
							projectLogs[projectID] = append(projectLogs[projectID], logRow)
						} else {
							data, _ := req.MarshalJSON()
							log.WithContext(ctx).WithField("LogEvent", event).WithField("LogRow", *logRow).WithField("RequestJSON", string(data)).Errorf("otel span log got no project")
							continue
						}
					}
				}
			}
		}
	}

	for sessionID, errors := range traceErrors {
		var backendError = false
		for _, err := range errors {
			if err.Type != highlight.SourceAttributeFrontend {
				backendError = true
			}
		}
		if backendError {
			err = o.resolver.BatchedQueue.Submit(ctx, &kafkaqueue.Message{
				Type: kafkaqueue.MarkBackendSetup,
				MarkBackendSetup: &kafkaqueue.MarkBackendSetupArgs{
					SessionSecureID: pointy.String(sessionID),
				},
			}, sessionID)
			if err != nil {
				log.WithContext(ctx).Error(err, "failed to submit otel mark backend setup")
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
		}

		err = o.resolver.ProducerQueue.Submit(ctx, &kafkaqueue.Message{
			Type: kafkaqueue.PushBackendPayload,
			PushBackendPayload: &kafkaqueue.PushBackendPayloadArgs{
				SessionSecureID: &sessionID,
				Errors:          errors,
			}}, sessionID)
		if err != nil {
			log.WithContext(ctx).Error(err, "failed to submit otel session errors to public worker queue")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
	}

	for projectID, errors := range projectErrors {
		var backendError = false
		for _, err := range errors {
			if err.Type != highlight.SourceAttributeFrontend {
				backendError = true
			}
		}
		if backendError {
			if projectIDInt, err := projectToInt(projectID); err == nil {
				err := o.resolver.BatchedQueue.Submit(ctx, &kafkaqueue.Message{
					Type: kafkaqueue.MarkBackendSetup,
					MarkBackendSetup: &kafkaqueue.MarkBackendSetupArgs{
						ProjectID: projectIDInt,
					},
				}, uuid.New().String())
				if err != nil {
					log.WithContext(ctx).Error(err, "failed to submit otel mark backend setup")
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
			}
		}

		err = o.resolver.ProducerQueue.Submit(ctx, &kafkaqueue.Message{
			Type: kafkaqueue.PushBackendPayload,
			PushBackendPayload: &kafkaqueue.PushBackendPayloadArgs{
				ProjectVerboseID: &projectID,
				Errors:           errors,
			}}, uuid.New().String())
		if err != nil {
			log.WithContext(ctx).Error(err, "failed to submit otel project errors to public worker queue")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
	}

	if err := o.submitProjectLogs(ctx, projectLogs, false); err != nil {
		log.WithContext(ctx).Error(err, "failed to submit otel project logs")
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (o *Handler) HandleLog(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		log.WithContext(ctx).Error(err, "invalid log body")
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	gz, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		log.WithContext(ctx).Error(err, "invalid gzip format for log")
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	output, err := io.ReadAll(gz)
	if err != nil {
		log.WithContext(ctx).Error(err, "invalid gzip stream for log")
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	req := plogotlp.NewExportRequest()
	err = req.UnmarshalProto(output)
	if err != nil {
		log.WithContext(ctx).Error(err, "invalid log protobuf")
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var projectLogs = make(map[string][]*clickhouse.LogRow)

	resourceLogs := req.Logs().ResourceLogs()
	for i := 0; i < resourceLogs.Len(); i++ {
		var projectID, sessionID, requestID, source string
		resource := resourceLogs.At(i).Resource()
		resourceAttributes := resource.Attributes().AsRaw()
		serviceName := cast(resource.Attributes().AsRaw()[string(semconv.ServiceNameKey)], "")
		setHighlightAttributes(resourceAttributes, &projectID, &sessionID, &requestID, &source)
		scopeLogs := resourceLogs.At(i).ScopeLogs()
		for j := 0; j < scopeLogs.Len(); j++ {
			logRecords := scopeLogs.At(j).LogRecords()
			for k := 0; k < logRecords.Len(); k++ {
				logRecord := logRecords.At(k)
				logAttributes := logRecord.Attributes().AsRaw()
				setHighlightAttributes(logAttributes, &projectID, &sessionID, &requestID, &source)
				projectIDInt, err := projectToInt(projectID)
				if err != nil {
					log.WithContext(ctx).WithField("ProjectID", projectID).WithField("LogMessage", logRecord.Body().AsRaw()).Errorf("otel log got invalid project id")
					continue
				}
				logRow := clickhouse.NewLogRow(clickhouse.LogRowPrimaryAttrs{
					Timestamp:       logRecord.Timestamp().AsTime(),
					TraceId:         logRecord.TraceID().String(),
					SpanId:          logRecord.SpanID().String(),
					ProjectId:       uint32(projectIDInt),
					SecureSessionId: sessionID,
				},
					clickhouse.WithLogAttributes(resourceAttributes, logAttributes),
					clickhouse.WithSeverityText(logRecord.SeverityText()),
				)

				logRow.ServiceName = serviceName
				logRow.Body = logRecord.Body().Str()
				if projectID != "" {
					if _, ok := projectLogs[projectID]; !ok {
						projectLogs[projectID] = []*clickhouse.LogRow{}
					}
					projectLogs[projectID] = append(projectLogs[projectID], logRow)
				} else {
					log.WithContext(ctx).WithField("LogRecord", logRecords).WithField("LogRow", *logRow).Errorf("otel log got no project")
					continue
				}
			}
		}
	}

	if err := o.submitProjectLogs(ctx, projectLogs, true); err != nil {
		log.WithContext(ctx).Error(err, "failed to submit otel project logs")
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (o *Handler) submitProjectLogs(ctx context.Context, projectLogs map[string][]*clickhouse.LogRow, backend bool) error {
	for projectID, logRows := range projectLogs {
		if projectIDInt, err := projectToInt(projectID); backend && err == nil {
			// otel logs only come from python sdk
			err := o.resolver.BatchedQueue.Submit(ctx, &kafkaqueue.Message{
				Type: kafkaqueue.MarkBackendSetup,
				MarkBackendSetup: &kafkaqueue.MarkBackendSetupArgs{
					ProjectID: projectIDInt,
				},
			}, uuid.New().String())
			if err != nil {
				return e.Wrap(err, "failed to submit otel mark backend setup")
			}
		}

		err := o.resolver.BatchedQueue.Submit(ctx, &kafkaqueue.Message{
			Type: kafkaqueue.PushLogs,
			PushLogs: &kafkaqueue.PushLogsArgs{
				LogRows: logRows,
			}}, uuid.New().String())
		if err != nil {
			return e.Wrap(err, "failed to submit otel project logs to public worker queue")
		}
	}
	return nil
}

func (o *Handler) Listen(r *chi.Mux) {
	r.Route("/otel/v1", func(r chi.Router) {
		r.HandleFunc("/traces", o.HandleTrace)
		r.HandleFunc("/logs", o.HandleLog)
	})
}

func New(resolver *graph.Resolver) *Handler {
	return &Handler{
		resolver: resolver,
	}
}
