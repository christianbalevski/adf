// The one list of views. Each feature owns views/<id>/ and its default export.

import fleet from './fleet/index'
import chat from './chat/index'
import files from './files/index'
import loops from './loops/index'
import inspect from './inspect/index'
import runtime from './runtime/index'
import type { ViewDefinition } from './types'

// Header order: the selected agent's views (1-4), then the app's (5-6).
export const VIEWS: ViewDefinition[] = [chat, files, loops, inspect, fleet, runtime]
