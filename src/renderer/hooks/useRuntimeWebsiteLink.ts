import { useCallback, useEffect, useRef } from 'react'
import { useDocumentStore } from '../stores/document.store'
import { reportFailure } from '../stores/failure-notices.store'
import { openRuntimeWebsiteLink } from '../utils/runtime-website-link'

/** Bind navigation to the document view, including while a lookup is pending. */
export function useRuntimeWebsiteLink() {
  const runtimeId = useDocumentStore((s) => s.runtimeId)
  const generation = useDocumentStore((s) => s.viewGeneration)
  const context = `${runtimeId}\n${generation}`
  const current = useRef<string | null>(context)
  current.current = context
  useEffect(() => {
    current.current = context
    return () => { current.current = null }
  }, [context])
  return useCallback((href: string) => {
    void openRuntimeWebsiteLink(href, runtimeId, () => current.current === context).catch((cause) => {
      if (current.current === context) reportFailure('Could not open the agent’s website', cause)
    })
  }, [runtimeId, context])
}
