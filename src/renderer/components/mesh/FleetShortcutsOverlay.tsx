import { memo } from 'react'

function Key({ k }: { k: string }) {
  return (
    <kbd className="px-1.5 py-0.5 min-w-[22px] text-center rounded border border-neutral-300 dark:border-neutral-600 bg-neutral-50 dark:bg-neutral-800 text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
      {k}
    </kbd>
  )
}

function Row({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1 shrink-0 w-[104px]">
        {keys.map((k) => <Key key={k} k={k} />)}
      </span>
      <span className="text-[12px] text-neutral-600 dark:text-neutral-300">{label}</span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">{title}</div>
      {children}
    </div>
  )
}

/**
 * Command card — every map hotkey on a blurred full-screen sheet. ? toggles,
 * Esc or a click anywhere dismisses.
 */
export const FleetShortcutsOverlay = memo(function FleetShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-white/40 dark:bg-black/40 backdrop-blur-md"
      style={{ animation: 'meshFadeIn 150ms ease-out' }}
      onClick={onClose}
    >
      <div
        className="grid grid-cols-2 gap-x-10 gap-y-5 px-8 py-6 rounded-2xl bg-white/95 dark:bg-neutral-900/95 border border-neutral-200 dark:border-neutral-700 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="col-span-2 flex items-baseline justify-between">
          <span className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">Keyboard commands</span>
          <span className="text-[10px] text-neutral-400 dark:text-neutral-500">? toggles · Esc closes</span>
        </div>
        <Section title="Camera">
          <Row keys={['↑', '↓', '←', '→']} label="pan the map" />
          <Row keys={['drag']} label="right- or middle-drag to pan" />
          <Row keys={['scroll']} label="two-finger pan · pinch to zoom" />
          <Row keys={['Space']} label="jump to selection / fit world" />
          <Row keys={['F']} label="full screen" />
        </Section>
        <Section title="Selection">
          <Row keys={['A']} label="select all running agents" />
          <Row keys={['⇧', 'click']} label="add or remove from selection" />
          <Row keys={['drag']} label="marquee select" />
          <Row keys={['⌘1-9']} label="assign control group" />
          <Row keys={['1-9']} label="recall control group" />
          <Row keys={['Esc']} label="clear selection" />
        </Section>
        <Section title="Command">
          <Row keys={['M']} label="message the selection" />
          <Row keys={['H']} label="hold / resume" />
          <Row keys={['G']} label="start selected (offline)" />
          <Row keys={['S']} label="stop selected (running)" />
          <Row keys={['Enter']} label="open focused agent" />
          <Row keys={['I']} label="inspect — full agent readout" />
          <Row keys={['2×click']} label="open agent + panel" />
        </Section>
        <Section title="Move">
          <Row keys={['drag tile']} label="move agent to a free hex (stays there)" />
          <Row keys={['⌥', 'drag']} label="move its whole group" />
          <Row keys={['⌘', 'drag']} label="move its whole territory" />
          <Row keys={['drag base']} label="move a runtime or channel platform" />
        </Section>
        <Section title="View">
          <Row keys={['L']} label="cycle lens (terrain · burn · model · health · lineage)" />
          <Row keys={['V']} label="toggle voices (group status chips)" />
          <Row keys={['.']} label="next agent needing you" />
          <Row keys={[',']} label="next idle agent" />
          <Row keys={['?']} label="this card" />
        </Section>
      </div>
    </div>
  )
})
