import EventEmitter from 'eventemitter3'
import { v4 } from 'uuid'
import * as Automerge from 'automerge-js'
import DocHandle from './DocHandle'
import StorageSubsystem from './storage/StorageSubsystem'

export interface RepoDocumentEventArg {
  handle: DocHandle
}
export interface RepoEvents {
  'document': (arg: RepoDocumentEventArg) => void
}

export default class Repo extends EventEmitter<RepoEvents> {
  handles: { [documentId: string] : DocHandle } = {}
  storageSubsystem

  constructor(storageSubsystem: StorageSubsystem) {
    super()
    this.storageSubsystem = storageSubsystem
  }

  cacheHandle(documentId: string): DocHandle {
    if (this.handles[documentId]) {
      return this.handles[documentId]
    }
    const handle = new DocHandle(documentId)
    this.handles[documentId] = handle
    return handle
  }

  /* this is janky, because it returns an empty (but editable) document
   * before anything loads off the network.
   * fixing this probably demands some work in automerge core.
   */
  async load(documentId: string): Promise<DocHandle> {
    const handle = this.cacheHandle(documentId)
    handle.replace(await this.storageSubsystem.load(documentId) || Automerge.init())
    this.emit('document', { handle })
    return handle
  }

  create(): DocHandle {
    const documentId = v4()
    const handle = this.cacheHandle(documentId)
    handle.replace(Automerge.init())
    this.emit('document', { handle })
    return handle
  }

  /**
   * find() locates a document by id
   * getting data from the local system but also by sending out a 'document'
   * event which a CollectionSynchronizer would use to advertise interest to other peers
   */
  async find(documentId: string): Promise<DocHandle> {
    // TODO: we want a way to make sure we don't yield
    //       intermediate document states during initial synchronization
    return this.handles[documentId] || this.load(documentId)
  }
}
