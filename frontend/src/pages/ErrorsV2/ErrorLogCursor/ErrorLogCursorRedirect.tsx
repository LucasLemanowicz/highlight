import { ErrorState } from '@components/ErrorState/ErrorState'
import { useGetErrorObjectForLogQuery } from '@graph/hooks'
import { useParams } from '@util/react-router/useParams'
import React from 'react'
import { Navigate } from 'react-router'

const ErrorLogCursorRedirect: React.FC = () => {
	const { cursor_id: logCursor } = useParams<{
		cursor_id: string
	}>() as { cursor_id: string }

	const { loading, data, error } = useGetErrorObjectForLogQuery({
		variables: { log_cursor: logCursor! },
		skip: !logCursor,
	})

	if (loading) {
		return null
	} else if (data?.error_object_for_log) {
		return (
			<Navigate
				replace
				to={`/errors/${data.error_object_for_log.error_group_secure_id}/instances/${data.error_object_for_log.id}`}
			></Navigate>
		)
	}
	return (
		<ErrorState
			title="No Error Found"
			errorString={JSON.stringify(error)}
			message={`The log didn't match any errors. `}
			shownWithHeader
		/>
	)
}

export default ErrorLogCursorRedirect
