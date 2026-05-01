import { create } from 'zustand'
import type { InboxMessage, RendererOutboxMessage } from '../../shared/types/adf.types'

interface InboxData {
  messages: InboxMessage[]
  mode: 'unrestricted' | 'only_channels' | 'disabled'
}

interface InboxStore {
  inboxData: InboxData | null
  unreadCount: number
  outboxMessages: RendererOutboxMessage[]

  setInboxData: (data: InboxData | null) => void
  updateUnreadCount: (count: number) => void
  markAsRead: (messageId: string) => void
  markAllAsRead: () => void
  clearMessages: () => void
  setOutboxMessages: (messages: RendererOutboxMessage[]) => void
}

export const useInboxStore = create<InboxStore>((set) => ({
  inboxData: null,
  unreadCount: 0,
  outboxMessages: [],

  setInboxData: (data) => {
    const unread = data?.messages?.filter((m) => m.status === 'unread').length || 0
    set({ inboxData: data, unreadCount: unread })
  },

  updateUnreadCount: (count) => set({ unreadCount: count }),

  markAsRead: (messageId) =>
    set((state) => {
      if (!state.inboxData) return state
      const messages = state.inboxData.messages.map((m) =>
        m.id === messageId ? { ...m, status: 'read' as const } : m
      )
      const unread = messages.filter((m) => m.status === 'unread').length
      return {
        inboxData: { ...state.inboxData, messages },
        unreadCount: unread
      }
    }),

  markAllAsRead: () =>
    set((state) => {
      if (!state.inboxData) return state
      const messages = state.inboxData.messages.map((m) => ({ ...m, status: 'read' as const }))
      return {
        inboxData: { ...state.inboxData, messages },
        unreadCount: 0
      }
    }),

  clearMessages: () => set({ inboxData: null, unreadCount: 0, outboxMessages: [] }),

  setOutboxMessages: (messages) => set({ outboxMessages: messages })
}))
