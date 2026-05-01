import { useDocumentStore } from '../../stores/document.store'

export function MindPanel() {
  const { mindContent, setMindContent } = useDocumentStore()

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMindContent(e.target.value)
    window.adfApi?.setMind(e.target.value)
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-neutral-200 dark:border-neutral-700">
        <h3 className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
          Mind
        </h3>
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          The agent&apos;s working memory and thoughts
        </p>
      </div>
      <textarea
        value={mindContent}
        onChange={handleChange}
        placeholder="Agent thoughts will appear here..."
        className="flex-1 p-3 text-sm text-neutral-700 dark:text-neutral-300 font-mono resize-none focus:outline-none bg-neutral-50 dark:bg-neutral-800"
      />
    </div>
  )
}
