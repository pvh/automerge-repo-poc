import { DocumentId, Message, PeerId } from "@automerge/automerge-repo"
import * as Auth from "@localfirst/auth"

export type Config = {
  device: Auth.DeviceWithSecrets
  user?: Auth.UserWithSecrets
  source?: string // persisted state
}

export type LocalFirstAuthMessagePayload = {
  shareId: ShareId
  serializedConnectionMessage: string
}

export type EncryptedMessage = {
  type: "encrypted"
  senderId: PeerId
  targetId: PeerId
  shareId: ShareId
  encryptedMessage: Auth.Base58
}
export const isEncryptedMessage = (
  message: Message | EncryptedMessage
): message is EncryptedMessage => message.type === "encrypted"

/**
 * A share is a set of document IDs that are shared with one or more users. The group is represented by a
 * localfirst/auth `Team` instance.
 */
export type Share = {
  shareId: ShareId
  team: Auth.Team

  /** If no document IDs are specified, then all documents are assumed to be shared */
  documentIds?: Set<DocumentId>
}
/** The team's ID is used as the ID for the share */

export type ShareId = Auth.Hash & { __shareId: true }
/** To save our state, we serialize each share */

export type SerializedShare = {
  shareId: ShareId
  encryptedTeam: Auth.Base58
  encryptedTeamKeys: Auth.Base58
  documentIds: DocumentId[]
}

export type SerializedState = Record<ShareId, SerializedShare>

type DeviceInvitation = {
  shareId: ShareId
  userName: string
  userId: string
  invitationSeed: string
}

type MemberInvitation = {
  shareId: ShareId
  invitationSeed: string
}

export type Invitation = DeviceInvitation | MemberInvitation

export const isDeviceInvitation = (
  invitation: Invitation
): invitation is DeviceInvitation => {
  return "userName" in invitation && "userId" in invitation
}

export type ErrorPayload = Auth.ConnectionErrorPayload & {
  shareId: ShareId
  peerId: PeerId
}

export type LocalFirstAuthProviderEvents = {
  /**
   * We've successfully joined a team using an invitation. This event provides the team graph and
   * the user's info (including keys). (When we're joining as a new device for an existing user,
   * this is how we get the user's keys.) This event gives the application a chance to persist the
   * team graph and the user's info.
   */
  joined: {
    shareId: ShareId
    peerId: PeerId
    team: Auth.Team
    user: Auth.User
  }

  /**
   * We're connected to a peer and have been mutually authenticated.
   */
  connected: {
    shareId: ShareId
    peerId: PeerId
  }

  /**
   * We've detected an error locally, e.g. a peer tries to join with an invalid invitation.
   */
  localError: ErrorPayload

  /**
   * Our peer has detected an error and reported it to us, e.g. we tried to join with an invalid
   * invitation.
   */
  remoteError: ErrorPayload

  /**
   * The auth connection disconnects from a peer after entering an error state.
   */
  disconnected: {
    shareId: ShareId
    peerId: PeerId
    event: Auth.ConnectionMessage
  }
}