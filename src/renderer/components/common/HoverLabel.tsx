import type { ReactNode } from 'react'
import { Tooltip } from './Tooltip'

/** A compact name beside an icon, sharing the tooltip's anchoring and keyboard behavior. */
export function HoverLabel({ name, children, className }: {
  name: string
  children: ReactNode
  className?: string
}) {
  return (
    <Tooltip tip={name} placement="right" appearance="label" delay={150} className={className}>
      {children}
    </Tooltip>
  )
}
