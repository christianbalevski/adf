/**
 * A minimal in-memory React host for renderer component tests in node (this
 * repo has no DOM test environment). It mounts real components with effects
 * and state updates running, keeps the host tree as plain objects, and
 * exposes its text and props. Built on react-reconciler (the version Ink uses).
 */
import { createContext, type ReactNode } from 'react'
import createReconciler from 'react-reconciler'
import { DefaultEventPriority, LegacyRoot, NoEventPriority } from 'react-reconciler/constants.js'

export interface HostNode { type: string; props: Record<string, unknown>; children: HostNode[]; text?: string; parent?: HostNode }

const append = (parent: HostNode, child: HostNode) => { child.parent = parent; parent.children.push(child) }
const remove = (parent: HostNode, child: HostNode) => { parent.children = parent.children.filter((c) => c !== child) }
const before = (parent: HostNode, child: HostNode, anchor: HostNode) => {
  remove(parent, child)
  child.parent = parent
  parent.children.splice(Math.max(0, parent.children.indexOf(anchor)), 0, child)
}
let priority = NoEventPriority
const ELEMENT_METHODS = { focus() {}, blur() {}, close() {}, showModal() {}, scrollIntoView() {}, addEventListener() {}, removeEventListener() {} }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reconciler = (createReconciler as any)({
  getRootHostContext: () => ({}),
  getChildHostContext: (ctx: object) => ctx,
  prepareForCommit: () => null,
  preparePortalMount: () => null,
  resetAfterCommit: () => {},
  clearContainer: () => false,
  shouldSetTextContent: () => false,
  // Element methods components call on refs (a <dialog>'s showModal/close, focus): no-ops here.
  createInstance: (type: string, props: Record<string, unknown>): HostNode => Object.assign({ type, props, children: [] }, ELEMENT_METHODS),
  createTextInstance: (text: string): HostNode => ({ type: '#text', props: {}, children: [], text }),
  resetTextContent: () => {},
  hideTextInstance: () => {},
  unhideTextInstance: () => {},
  hideInstance: () => {},
  unhideInstance: () => {},
  getPublicInstance: (i: HostNode) => i,
  appendInitialChild: append,
  appendChild: append,
  insertBefore: before,
  appendChildToContainer: append,
  insertInContainerBefore: before,
  removeChild: remove,
  removeChildFromContainer: remove,
  finalizeInitialChildren: () => false,
  commitUpdate: (node: HostNode, _type: string, _old: unknown, props: Record<string, unknown>) => { node.props = props },
  commitTextUpdate: (node: HostNode, _old: string, text: string) => { node.text = text },
  isPrimaryRenderer: true,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  supportsMicrotasks: true,
  scheduleMicrotask: queueMicrotask,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  detachDeletedInstance: () => {},
  getInstanceFromNode: () => null,
  prepareScopeUpdate: () => {},
  getInstanceFromScope: () => null,
  setCurrentUpdatePriority: (p: number) => { priority = p },
  getCurrentUpdatePriority: () => priority,
  resolveUpdatePriority: () => (priority !== NoEventPriority ? priority : DefaultEventPriority),
  maySuspendCommit: () => false,
  NotPendingTransition: undefined,
  HostTransitionContext: createContext(null),
  resetFormInstance: () => {},
  requestPostPaintCallback: () => {},
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: () => {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  preloadInstance: () => true,
  startSuspendingCommit: () => {},
  suspendInstance: () => {},
  waitForCommitToBeReady: () => null,
  rendererPackageName: 'adf-test-host',
  rendererVersion: '0.0.0',
})

export interface Mounted {
  root: HostNode
  /** Errors React reported while rendering (a test should assert this is empty). */
  errors: unknown[]
  /** All text, in tree order, joined by single spaces. */
  text(): string
  /** Host nodes whose props match `match`. */
  find(match: (node: HostNode) => boolean): HostNode[]
  unmount(): void
}

export function mount(element: ReactNode): Mounted {
  const root: HostNode = { type: '#root', props: {}, children: [] }
  const errors: unknown[] = []
  const record = (err: unknown) => { errors.push(err) }
  const container = reconciler.createContainer(root, LegacyRoot, null, false, null, 'test', record, record, record, () => {})
  reconciler.updateContainerSync(element, container, null, () => {})
  reconciler.flushSyncWork()
  const walk = (node: HostNode, out: HostNode[]) => { out.push(node); for (const c of node.children) walk(c, out); return out }
  return {
    root,
    errors,
    text: () => walk(root, []).filter((n) => n.type === '#text').map((n) => n.text).join(' ').replace(/\s+/g, ' ').trim(),
    find: (match) => walk(root, []).filter(match),
    unmount: () => { reconciler.updateContainerSync(null, container, null, () => {}); reconciler.flushSyncWork() },
  }
}
