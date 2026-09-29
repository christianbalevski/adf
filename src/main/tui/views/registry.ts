// The one list of views. Each feature owns views/<id>/ and its default export.

import fleet from './fleet/index'
import chat from './chat/index'
import files from './files/index'
import loops from './loops/index'
import inspect from './inspect/index'
import runtime from './runtime/index'
import type { ViewDefinition } from './types'

export const VIEWS: ViewDefinition[] = [fleet, chat, files, loops, inspect, runtime]
