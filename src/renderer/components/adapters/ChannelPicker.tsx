import { findAdapterRegistryEntry } from '../../../shared/constants/adapter-registry'
import { BrandMark } from '../common/BrandMark'
import { PickerGrid, PickerTile } from '../common/PickerTile'

/**
 * A tile per channel type. Used by Settings → Channels while nothing is
 * connected, and by an agent's Add channel dialog.
 */
export function ChannelPicker({ types, onPick }: { types: string[]; onPick: (type: string) => void }) {
  return (
    <PickerGrid>
      {types.map((type) => {
        const entry = findAdapterRegistryEntry(type)
        const label = entry?.displayName ?? type
        return (
          <PickerTile
            key={type}
            icon={<BrandMark iconKey={entry?.iconKey} label={label} size={28} />}
            title={label}
            detail={entry?.tagline ?? entry?.description ?? `Channel type "${type}"`}
            onClick={() => onPick(type)}
          />
        )
      })}
    </PickerGrid>
  )
}
