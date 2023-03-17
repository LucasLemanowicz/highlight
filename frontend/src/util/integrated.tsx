import { useAuthContext } from '@authentication/AuthContext'
import {
	useGetClientIntegrationDataLazyQuery,
	useGetServerIntegrationDataLazyQuery,
	useIsBackendIntegratedLazyQuery,
	useIsIntegratedLazyQuery,
} from '@graph/hooks'
import { useNumericProjectId } from '@hooks/useProjectId'
import useLocalStorage from '@rehooks/local-storage'
import analytics from '@util/analytics'
import { useParams } from '@util/react-router/useParams'
import { useEffect, useState } from 'react'

export const useIntegrated = (): { integrated: boolean; loading: boolean } => {
	const { isLoggedIn, isAuthLoading } = useAuthContext()
	const { projectId } = useNumericProjectId()
	const [query, { data, loading }] = useIsIntegratedLazyQuery({
		variables: { project_id: projectId! },
		fetchPolicy: 'cache-and-network',
	})
	const [localStorageIntegrated, setLocalStorageIntegrated] = useLocalStorage(
		`highlight-${projectId}-integrated`,
		false,
	)
	const [integrated, setIntegrated] = useState<boolean | undefined>(undefined)
	const [loadingState, setLoadingState] = useState(true)
	const integratedRaw = data?.isIntegrated

	useEffect(() => {
		if (!isLoggedIn) return
		if (!localStorageIntegrated) {
			query()
			const timer = setInterval(() => {
				if (!integrated) {
					query()
				} else {
					clearInterval(timer)
				}
			}, 5000)
			return () => {
				clearInterval(timer)
			}
		} else {
			setLoadingState(false)
			setIntegrated(localStorageIntegrated)
		}
	}, [integrated, localStorageIntegrated, query, isLoggedIn])

	useEffect(() => {
		if (integratedRaw !== undefined) {
			setIntegrated(integratedRaw?.valueOf())
			setLocalStorageIntegrated(integratedRaw?.valueOf() || false)
			if (
				localStorageIntegrated === false &&
				integratedRaw?.valueOf() === true
			) {
				analytics.track('IntegratedProject', { id: projectId })
			}
		}
	}, [
		integratedRaw,
		localStorageIntegrated,
		projectId,
		setLocalStorageIntegrated,
	])

	useEffect(() => {
		if (loading === false) {
			setLoadingState(false)
		}
	}, [loading])

	// Assume that app is integrated if viewing session as guest and not loading
	if (!isLoggedIn) {
		return { integrated: !isAuthLoading, loading: isAuthLoading }
	}

	return { integrated: integrated || false, loading: loadingState }
}

export const useBackendIntegrated = (): {
	integrated: boolean
	loading: boolean
} => {
	const { isLoggedIn, isAuthLoading } = useAuthContext()
	const { project_id } = useParams<{ project_id: string }>()
	const [query, { data, loading }] = useIsBackendIntegratedLazyQuery({
		variables: { project_id: project_id?.toString() ?? '' },
		fetchPolicy: 'cache-and-network',
	})
	const [localStorageIntegrated, setLocalStorageIntegrated] = useLocalStorage(
		`highlight-${project_id}-backend-integrated`,
		false,
	)
	const [integrated, setIntegrated] = useState<boolean | undefined>(undefined)
	const [loadingState, setLoadingState] = useState(true)
	const integratedRaw = data?.isBackendIntegrated

	useEffect(() => {
		if (!isLoggedIn) return
		if (!localStorageIntegrated) {
			query()
			const timer = setInterval(() => {
				if (!integrated) {
					query()
				} else {
					clearInterval(timer)
				}
			}, 5000)
			return () => {
				clearInterval(timer)
			}
		} else {
			setLoadingState(false)
			setIntegrated(localStorageIntegrated)
		}
	}, [integrated, localStorageIntegrated, query, isLoggedIn])

	useEffect(() => {
		if (integratedRaw !== undefined) {
			setIntegrated(integratedRaw?.valueOf())
			setLocalStorageIntegrated(integratedRaw?.valueOf() || false)
			if (
				localStorageIntegrated === false &&
				integratedRaw?.valueOf() === true
			) {
				analytics.track('IntegratedProjectBackend', { id: project_id })
			}
		}
	}, [
		integratedRaw,
		localStorageIntegrated,
		project_id,
		setLocalStorageIntegrated,
	])

	useEffect(() => {
		if (loading === false) {
			setLoadingState(false)
		}
	}, [loading])

	// Assume that app is integrated if viewing session as guest and not loading
	if (!isLoggedIn) {
		return { integrated: !isAuthLoading, loading: isAuthLoading }
	}

	return { integrated: integrated || false, loading: loadingState }
}

export const useClientIntegrated = () => {
	const { isLoggedIn } = useAuthContext()
	const { projectId } = useNumericProjectId()
	const [query, { data, loading }] = useGetClientIntegrationDataLazyQuery({
		variables: { project_id: projectId! },
		fetchPolicy: 'cache-and-network',
	})
	const [localStorageIntegrated, setLocalStorageIntegrated] = useLocalStorage(
		`highlight-${projectId}-client-integrated`,
		false,
	)
	const [integrated, setIntegrated] = useState<boolean | undefined>(undefined)
	const integratedRaw = !!data?.clientIntegrationData

	useEffect(() => {
		if (!isLoggedIn) return
		if (!localStorageIntegrated) {
			query()
			const timer = setInterval(() => {
				if (!integrated) {
					query()
				} else {
					clearInterval(timer)
				}
			}, 5000)
			return () => {
				clearInterval(timer)
			}
		} else {
			setIntegrated(localStorageIntegrated)
		}
	}, [integrated, localStorageIntegrated, query, isLoggedIn])

	useEffect(() => {
		if (integratedRaw !== undefined) {
			setIntegrated(integratedRaw?.valueOf())
			setLocalStorageIntegrated(integratedRaw?.valueOf() || false)
			if (
				localStorageIntegrated === false &&
				integratedRaw?.valueOf() === true
			) {
				analytics.track('IntegratedClient', { id: projectId })
			}
		}
	}, [
		integratedRaw,
		localStorageIntegrated,
		projectId,
		setLocalStorageIntegrated,
	])

	return {
		data: data?.clientIntegrationData || false,
		loading,
	}
}

export const useServerIntegrated = () => {
	const { isLoggedIn } = useAuthContext()
	const { projectId } = useNumericProjectId()
	const [query, { data, loading }] = useGetServerIntegrationDataLazyQuery({
		variables: { project_id: projectId! },
		fetchPolicy: 'cache-and-network',
	})
	const [localStorageIntegrated, setLocalStorageIntegrated] = useLocalStorage(
		`highlight-${projectId}-server-integrated`,
		false,
	)
	const [integrated, setIntegrated] = useState<boolean | undefined>(undefined)
	const integratedRaw = !!data?.serverIntegrationData

	useEffect(() => {
		if (!isLoggedIn) return
		if (!localStorageIntegrated) {
			query()
			const timer = setInterval(() => {
				if (!integrated) {
					query()
				} else {
					clearInterval(timer)
				}
			}, 5000)
			return () => {
				clearInterval(timer)
			}
		} else {
			setIntegrated(localStorageIntegrated)
		}
	}, [integrated, localStorageIntegrated, query, isLoggedIn])

	useEffect(() => {
		if (integratedRaw !== undefined) {
			setIntegrated(integratedRaw?.valueOf())
			setLocalStorageIntegrated(integratedRaw?.valueOf() || false)
			if (
				localStorageIntegrated === false &&
				integratedRaw?.valueOf() === true
			) {
				analytics.track('IntegratedClient', { id: projectId })
			}
		}
	}, [
		integratedRaw,
		localStorageIntegrated,
		projectId,
		setLocalStorageIntegrated,
	])

	return {
		data: data?.serverIntegrationData || false,
		loading,
	}
}
