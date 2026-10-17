/** A recipient written as a URL (`http://…/agents/x/card`), not a DID, handle or `type:id`. */
export function isUrlRecipient(recipient: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(recipient.trim())
}

export function urlRecipientError(recipient: string): string {
  return `msg_send: recipient "${recipient}" is a URL. recipient takes the agent's DID (did:key:…) and address takes its inbox URL (…/agents/<handle>/inbox). Read both from the agent's card (the URL ending in /card, or agent_discover).`
}
