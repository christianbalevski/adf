interface Props {
  filePath: string
}

export function BinaryFilePlaceholder({ filePath }: Props) {
  const fileName = filePath.split('/').pop() ?? filePath

  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-neutral-400 dark:text-neutral-500">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{fileName}</span>
      <span className="text-xs">Binary file cannot be edited</span>
    </div>
  )
}
