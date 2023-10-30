import type {
  AuthMessage,
  DocumentId,
  PeerId,
  RepoMessage,
} from "@automerge/automerge-repo"
import {
  AuthProvider,
  AuthenticatedNetworkAdapter,
  NetworkAdapter,
  isAuthMessage,
} from "@automerge/automerge-repo"
import * as Auth from "@localfirst/auth"
import debug from "debug"
import { forwardEvents } from "./forwardEvents"
import {
  Config,
  EncryptedMessage,
  Invitation,
  LocalFirstAuthProviderEvents,
  SerializedShare,
  SerializedState,
  Share,
  ShareId,
  isDeviceInvitation,
  isEncryptedMessage,
} from "./types"

const { encrypt, decrypt } = Auth.symmetric

export class LocalFirstAuthProvider extends AuthProvider<LocalFirstAuthProviderEvents> {
  #device: Auth.DeviceWithSecrets
  #user?: Auth.UserWithSecrets
  #invitations = {} as Record<ShareId, Invitation>
  #shares = {} as Record<ShareId, Share>
  #connections = {} as Record<ShareId, Record<PeerId, Auth.Connection>>
  #peers: PeerId[] = []
  #log: debug.Debugger

  constructor(config: Config) {
    super()
    // we always are given the local device's info & keys
    this.#device = config.device

    // we might already have our user info, unless we're a new device using an invitation
    if ("user" in config) this.#user = config.user

    // we might have persisted state to load
    if ("source" in config) this.load(config.source)

    this.#log = debug(`automerge-repo:auth-localfirst:${this.#device.userId}`)
  }

  /**
   * Encrypt and decrypt messages using the session keys from the auth connections.
   */
  transform = {
    inbound: (message: RepoMessage | EncryptedMessage) => {
      if (isEncryptedMessage(message)) {
        const { encryptedMessage, shareId, senderId } = message
        const { sessionKey } = this.#getConnection(shareId, senderId)
        const decryptedMessage = decrypt(encryptedMessage, sessionKey)
        return decryptedMessage as RepoMessage
      } else {
        return message
      }
    },
    outbound: (message: RepoMessage): EncryptedMessage => {
      const { targetId } = message
      const shareId = this.#getShareIdForMessage(message)
      const sessionKey = this.#getConnection(shareId, targetId).sessionKey

      return {
        type: "encrypted",
        senderId: this.#device.userId as PeerId,
        targetId,
        shareId,
        encryptedMessage: encrypt(message, sessionKey),
      }
    },
  }

  /**
   * Intercept the network adapter's events. For each new peer, we create a localfirst/auth
   * connection and use it to mutually authenticate before forwarding the peer-candidate event.
   */
  wrapNetworkAdapter = (baseAdapter: NetworkAdapter) => {
    this.#log("wrapping network adapter")
    const authenticatedAdapter = new AuthenticatedNetworkAdapter(
      baseAdapter,
      this.transform
    )

    /**
     * An auth connection executes the localfirst/auth protocol to authenticate a peer, negotiate a
     * shared secret key for the session, and sync up the team graph. This communication happens
     * over the network adapter we're wrapping.
     */
    const createAuthConnection = (shareId: ShareId, peerId: PeerId) => {
      // Use the base adapter to send auth messages to the peer
      const sendMessage: Auth.SendFunction = serializedConnectionMessage => {
        const authMessage: AuthMessage = {
          type: "auth",
          senderId: baseAdapter.peerId!,
          targetId: peerId,
          payload: { shareId, serializedConnectionMessage },
        }
        baseAdapter.send(authMessage)
      }

      const connection = new Auth.Connection({
        context: this.#getContext(shareId),
        sendMessage,
        peerUserId: peerId,
      })

      connection
        .on("joined", ({ team, user }) => {
          // When we successfully join a team, the connection gives us the team graph and the user's
          // info (including keys). (When we're joining as a new device for an existing user, this
          // is how we get the user's keys.)

          this.#log(`joined ${team.name}`)

          // Let the application know, e.g. so it can persist this information, subscribe to team
          // updates, etc.
          this.emit("joined", { team, user })

          this.#user = user
          this.#shares[shareId] = { shareId, team }

          // remove the used invitation as we no longer need it & don't want to present it to others
          delete this.#invitations[shareId]
        })

        .on("connected", () => {
          this.#log(`connected to ${peerId}`)

          // Let the application know
          this.emit("connected", { shareId, peerId })

          // Let the repo know we've got a new peer
          authenticatedAdapter.emit("peer-candidate", { peerId })
        })

        .on("localError", event => {
          // These are errors that are detected locally, e.g. a peer tries to join with an invalid
          // invitation
          this.#log(`localError: ${JSON.stringify(event)}`)

          // Let the application know, e.g. to let me decide if I want to allow the peer to retry
          this.emit("localError", { shareId, peerId, ...event })
        })

        .on("remoteError", event => {
          // These are errors that are detected on the peer and reported to us, e.g. a peer rejects
          // an invitation we tried to join with
          this.#log(`remoteError: ${JSON.stringify(event)}`)

          // Let the application know, e.g. to let me retry
          this.emit("remoteError", { shareId, peerId, ...event })
        })

        .on("disconnected", event => {
          this.#log(`disconnected from ${peerId} (${JSON.stringify(event)})`)
          this.#removeConnection(shareId, peerId)

          // Let the application know
          this.emit("disconnected", { shareId, peerId, event })

          // Let the repo know
          authenticatedAdapter.emit("peer-disconnected", { peerId })
        })

      connection.start()

      return connection
    }

    // try to authenticate new peers; if we succeed, we forward the peer-candidate event
    baseAdapter.on("peer-candidate", async ({ peerId }) => {
      this.#peers.push(peerId)

      const shareIds = [
        ...Object.keys(this.#shares),
        ...Object.keys(this.#invitations),
      ] as ShareId[]

      // We optimistically spin up a connection for each share we have and every unused invitation
      // we have. Messages regarding shares we're not a member of will be ignored.
      for (const shareId of shareIds) {
        const connection = createAuthConnection(shareId, peerId)
        this.#addConnection(shareId, peerId, connection)
      }
    })

    // examine inbound messages; deliver auth connection messages to the appropriate connection, and
    // pass through all other messages
    baseAdapter.on("message", message => {
      try {
        if (isAuthMessage(message)) {
          const { senderId, payload } = message
          const { shareId, serializedConnectionMessage } = payload

          // If we don't have this shareId, ignore the message
          if (!(shareId in this.#connections)) return

          const connection = this.#getConnection(shareId, senderId)
          // Pass message to the auth connection  (these messages aren't the repo's concern)
          connection.deliver(serializedConnectionMessage)
        } else {
          // Decrypt message if necessary
          const transformedPayload = this.transform.inbound(message)
          // Forward the message to the repo
          authenticatedAdapter.emit("message", transformedPayload)
        }
      } catch (e) {
        // Surface any errors to the repo
        authenticatedAdapter.emit("error", {
          peerId: message.senderId,
          error: e,
        })
      }
    })

    // forward all other events from the base adapter to the repo
    forwardEvents(baseAdapter, authenticatedAdapter, [
      "ready",
      "close",
      "peer-disconnected",
      "error",
    ])

    return authenticatedAdapter
  }

  #addConnection = (
    shareId: ShareId,
    peerId: PeerId,
    connection: Auth.Connection
  ) => {
    if (!this.#connections[shareId]) this.#connections[shareId] = {}
    this.#connections[shareId][peerId] = connection
  }

  #getConnection = (shareId: ShareId, peerId: PeerId) => {
    const connections = this.#connections[shareId]
    const connection = connections?.[peerId]
    if (!connection) throw new Error(`Connection not found`)
    return connection
  }

  #removeConnection = (shareId: ShareId, peerId: PeerId) => {
    delete this.#connections[shareId][peerId]
  }

  /** Returns the shareId to use for encrypting the given message */
  #getShareIdForMessage = ({ documentId, targetId }: RepoMessage) => {
    // Since the raw network adapters don't know anything about ShareIds, when we're given a message
    // to encrypt and send out, we need to figure out which auth connection it belongs to, in order
    // to retrieve the right session key to use for encryption.

    // First we need to find all shareIds for which we have connections with the target peer
    const allShareIds = Object.keys(this.#shares) as ShareId[]
    const shareIdsForPeer = allShareIds.filter(
      shareId => targetId in this.#connections[shareId]
    )

    if (shareIdsForPeer.length === 0)
      throw new Error(`No share found for peer ${targetId}`)

    // Typically there should be exactly one shareId for a given peer
    if (shareIdsForPeer.length === 1) return shareIdsForPeer[0]

    // However it's possible to have multiple auth connections with the same peer (one for each
    // share we're both a member of). To figure out which one to use, we need to look at the
    // documentId. If the same documentId is included in multiple shares with the same peer, we can
    // use any of those session keys, but we need to pick one consistently.

    // TODO: use documentId to pick the right share
    // For now, just pick the shareId the lowest session key
    const bySessionKey = (a: ShareId, b: ShareId) => {
      const aConnection = this.#getConnection(a, targetId)
      const bConnection = this.#getConnection(b, targetId)
      return aConnection.sessionKey.localeCompare(bConnection.sessionKey)
    }
    return shareIdsForPeer.sort(bySessionKey)[0]
  }

  #getContext = (shareId: ShareId) => {
    const device = this.#device
    const user = this.#user
    const invitation = this.#invitations[shareId]
    const share = this.#shares[shareId]
    if (share)
      // this is a share we're already a member of
      return {
        device,
        user,
        team: share.team,
      } as Auth.MemberInitialContext
    else if (invitation)
      if (isDeviceInvitation(invitation))
        // this is a share we've been invited to as a device
        return {
          device,
          ...invitation,
        } as Auth.InviteeDeviceInitialContext
      else {
        // this is a share we've been invited to as a member
        return {
          device,
          user,
          ...invitation,
        } as Auth.InviteeMemberInitialContext
      }

    // we don't know about this share
    throw new Error(`no context for ${shareId}`)
  }

  // PUBLIC API

  /** Returns a serialized and partially encrypted version of the state that can be persisted and loaded later */
  public save() {
    const shares = {} as SerializedState
    for (const shareId in this.#shares) {
      const share = this.#shares[shareId]
      shares[shareId] = {
        encryptedTeam: share.team.save(),
        encryptedTeamKeys: encrypt(
          share.team.teamKeys,
          this.#device.keys.secretKey
        ),
      } as SerializedShare
    }
    return JSON.stringify(shares)
  }

  /** Loads and decrypts state from its serialized, persisted form */
  public load(savedState: string) {
    const savedShares = JSON.parse(savedState) as SerializedState
    for (const shareId in savedShares) {
      const share = savedShares[shareId] as SerializedShare
      const { encryptedTeam, encryptedTeamKeys } = share
      const teamKeys = decrypt(
        encryptedTeamKeys,
        this.#device.keys.secretKey
      ) as Auth.KeysetWithSecrets

      const context = { device: this.#device, user: this.#user }
      this.#shares[shareId] = {
        team: Auth.loadTeam(encryptedTeam, context, teamKeys),
        teamKeys: teamKeys,
        connections: {},
      }
    }
  }

  public addTeam(team: Auth.Team) {
    const { id: shareId } = team
    this.#shares[shareId] = { shareId, team }
  }

  public addInvitation(invitation: Invitation) {
    const { shareId } = invitation
    this.#invitations[shareId] = invitation
  }

  public addDocuments(shareId: ShareId, documentIds: DocumentId[]) {
    throw new Error("not implemented")
    // const share = this.getShare(shareId)
    // documentIds.forEach(id => share.documentIds.add(id))
  }

  public removeDocuments(shareId: ShareId, documentIds: DocumentId[]) {
    throw new Error("not implemented")
    // const share = this.getShare(shareId)
    // documentIds.forEach(id => share.documentIds.delete(id))
  }
}