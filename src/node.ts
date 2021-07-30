import { Bytes, MarshalVersion, MetadataMapping, NodeType, Reference, StorageLoader, StorageSaver } from './types'
import {
  checkReference,
  common,
  encryptDecrypt,
  equalBytes,
  findIndexOfArray,
  flattenBytesArray,
  fromBigEndian,
  IndexBytes,
  keccak256Hash,
  toBigEndianFromUint16,
} from './utils'

const pathSeparator = '/'

type ForkMapping = { [key: number]: MantarayFork }

const nodeForkSizes = {
  nodeType: 1,
  prefixLength: 1,
  /** Bytes length before `reference` */
  preReference: 32,
  metadata: 2,
  header: (): number => nodeForkSizes.nodeType + nodeForkSizes.prefixLength, // 2
  prefixMaxSize: (): number => nodeForkSizes.preReference - nodeForkSizes.header(), // 30
} as const

const nodeHeaderSizes = {
  obfuscationKey: 32,
  versionHash: 31,
  /** Its value represents how long is the `entry` in bytes */
  refBytes: 1,
  full: (): number => {
    return nodeHeaderSizes.obfuscationKey + nodeHeaderSizes.versionHash + nodeHeaderSizes.refBytes
  },
} as const

class NotFoundError extends Error {
  constructor() {
    super('Not found')
  }
}

class EmptyPathError extends Error {
  constructor() {
    super('Empty path')
  }
}

class UndefinedField extends Error {
  constructor(field: string) {
    super(`"${field}" field is not initialized.`)
  }
}

class PropertyIsUndefined extends Error {
  constructor() {
    super(`Property does not exist in the object`)
  }
}

class NotImplemented extends Error {
  constructor() {
    super('Not Implemented')
  }
}

export class MantarayFork {
  /**
   * @param prefix the non-branching part of the subpath
   * @param node in memory structure that represents the Node
   */
  constructor(public prefix: Uint8Array, public node: MantarayNode) {}

  public serialize(): Uint8Array {
    const nodeType = this.node.getType

    const prefixLengthBytes = new Uint8Array(1)
    prefixLengthBytes[0] = this.prefix.length

    const prefixBytes = new Uint8Array(nodeForkSizes.prefixMaxSize())
    prefixBytes.set(this.prefix)

    const entry: Reference | undefined = this.node.getContentAddress

    if (!entry) throw Error('cannot serialize MantarayFork because it does not have contentAddress')

    const data = new Uint8Array([nodeType, ...prefixLengthBytes, ...prefixBytes, ...entry])

    if (this.node.IsWithMetadataType()) {
      const jsonString = JSON.stringify(this.node.getMetadata)
      const metadataBytes = new TextEncoder().encode(jsonString)

      // pad JSON bytes if necessary -> the encryptDecrypt handles if the data has no key length

      const metadataBytesSize = toBigEndianFromUint16(metadataBytes.length)

      return new Uint8Array([...data, ...metadataBytesSize, ...metadataBytes])
    }

    return data
  }

  public static deserialize(
    data: Uint8Array,
    obfuscationKey: Bytes<32>,
    options?: {
      withMetadata?: {
        refBytesSize: number
        metadataByteSize: number
      }
    },
  ): MantarayFork {
    const nodeType = data[0]
    const prefixLength = data[1]

    if (prefixLength === 0 || prefixLength > nodeForkSizes.prefixMaxSize()) {
      throw Error(`Prefix length of fork is greater than ${nodeForkSizes.prefixMaxSize()}. Got: ${prefixLength}`)
    }

    const headerSize = nodeForkSizes.header()
    const prefix = data.slice(headerSize, headerSize + prefixLength)
    const node = new MantarayNode()
    node.setObfuscationKey = obfuscationKey

    const withMetadata = options?.withMetadata

    if (withMetadata) {
      const { refBytesSize, metadataByteSize } = withMetadata

      if (metadataByteSize > 0) {
        node.setEntry = data.slice(nodeForkSizes.preReference, nodeForkSizes.preReference + refBytesSize) as
          | Bytes<32>
          | Bytes<64>

        const startMetadata = nodeForkSizes.preReference + refBytesSize + nodeForkSizes.metadata
        const metadataBytes = data.slice(startMetadata, startMetadata + metadataByteSize)

        const jsonString = new TextDecoder().decode(metadataBytes)
        node.setMetadata = JSON.parse(jsonString)
      }
    } else {
      node.setEntry = data.slice(nodeForkSizes.preReference) as Bytes<32> | Bytes<64>
    }
    node.setType = nodeType

    return new MantarayFork(prefix, node)
  }
}

export class MantarayNode {
  /** Used with NodeType type */
  private type?: number
  private obfuscationKey?: Bytes<32>
  /** reference of a loaded manifest node. if undefined, the node can be handled as `dirty` */
  private contentAddress?: Reference
  /** reference of an content that the manifest refers to */
  private entry?: Reference
  private metadata?: MetadataMapping
  /** Forks of the manifest. Has to be initialized with `{}` on load even if there were no forks */
  public forks?: ForkMapping

  /// Setters/getters

  public set setContentAddress(contentAddress: Reference) {
    checkReference(contentAddress)

    this.contentAddress = contentAddress
  }

  public set setEntry(entry: Reference) {
    checkReference(entry)

    this.entry = entry

    if (!equalBytes(entry, new Uint8Array(entry.length))) this.makeValue()

    this.makeDirty()
  }

  public set setType(type: number) {
    if (type > 255) throw Error(`Node type representation cannot be greater than 255`)

    this.type = type
  }

  public set setObfuscationKey(obfuscationKey: Bytes<32>) {
    if (!(obfuscationKey instanceof Uint8Array)) {
      throw new Error('Given obfuscationKey is not an Uint8Array instance.')
    }

    if (obfuscationKey.length !== 32) {
      throw new Error(`Wrong obfuscationKey length. Entry only can be 32 length in bytes`)
    }

    this.obfuscationKey = obfuscationKey
    this.makeDirty()
  }

  public set setMetadata(metadata: MetadataMapping) {
    this.metadata = metadata
    this.makeWithMetadata()
    this.makeDirty()
  }

  public get getObfuscationKey(): Bytes<32> {
    if (!this.obfuscationKey) throw PropertyIsUndefined

    return this.obfuscationKey
  }

  public get getEntry(): Reference {
    if (!this.entry) throw PropertyIsUndefined

    return this.entry
  }

  public get getContentAddress(): Reference | undefined {
    return this.contentAddress
  }

  public get getMetadata(): MetadataMapping {
    if (!this.metadata) throw PropertyIsUndefined

    return this.metadata
  }

  public get getType(): number {
    if (this.type === undefined) throw PropertyIsUndefined

    if (this.type > 255) throw 'Property "type" in Node is greater than 255'

    return this.type
  }

  /// Node type related functions
  /// dirty flag is not necessary to be set

  public isValueType(): boolean {
    if (!this.type) throw PropertyIsUndefined
    const typeMask = this.type & NodeType.value

    return typeMask === NodeType.value
  }

  public isEdgeType(): boolean {
    if (!this.type) throw PropertyIsUndefined
    const typeMask = this.type & NodeType.edge

    return typeMask === NodeType.edge
  }

  public isWithPathSeparatorType(): boolean {
    if (!this.type) throw PropertyIsUndefined
    const typeMask = this.type & NodeType.withPathSeparator

    return typeMask === NodeType.withPathSeparator
  }

  public IsWithMetadataType(): boolean {
    if (!this.type) throw PropertyIsUndefined
    const typeMask = this.type & NodeType.withMetadata

    return typeMask === NodeType.withMetadata
  }

  private makeValue() {
    if (!this.type) this.type = NodeType.value
    this.type |= NodeType.value
  }

  private makeEdge() {
    if (!this.type) this.type = NodeType.edge
    this.type |= NodeType.edge
  }

  private makeWithPathSeparator() {
    if (!this.type) this.type = NodeType.withPathSeparator
    this.type |= NodeType.withPathSeparator
  }

  private makeWithMetadata() {
    if (!this.type) this.type = NodeType.withMetadata
    this.type |= NodeType.withMetadata
  }

  private makeNotWithPathSeparator() {
    if (!this.type) throw PropertyIsUndefined
    this.type = (NodeType.mask ^ NodeType.withPathSeparator) & this.type
  }

  private updateWithPathSeparator(path: Uint8Array) {
    if (new TextDecoder().decode(path).includes(pathSeparator)) {
      this.makeWithPathSeparator()
    } else {
      this.makeNotWithPathSeparator()
    }
  }

  /// BL methods

  /**
   *
   * @param path path sting represented in bytes. can be 0 length, then `entry` will be the current node's entry
   * @param entry
   * @param metadata
   * @param storage
   */
  public addFork(path: Uint8Array, entry: Reference, metadata: MetadataMapping = {}): void {
    if (path.length === 0) {
      this.setEntry = entry

      if (Object.keys(metadata).length > 0) {
        this.setMetadata = metadata
      }
      this.makeDirty()

      return
    }

    if (this.isDirty() && !this.forks) this.forks = {}

    if (!this.forks) throw Error(`Fork mapping is not defined in the manifest`)

    const fork = this.forks[path[0]]

    if (!fork) {
      const newNode = new MantarayNode()

      if (this.obfuscationKey) {
        newNode.setObfuscationKey = this.obfuscationKey
      }

      if (path.length > nodeForkSizes.prefixMaxSize()) {
        const prefix = path.slice(0, nodeForkSizes.prefixMaxSize())
        const rest = path.slice(nodeForkSizes.prefixMaxSize())
        newNode.addFork(rest, entry, metadata)
        newNode.updateWithPathSeparator(prefix)
        this.forks[path[0]] = new MantarayFork(prefix, newNode)
        this.makeEdge()

        return
      }

      newNode.setEntry = entry

      if (Object.keys(metadata).length > 0) {
        newNode.setMetadata = metadata
      }

      newNode.updateWithPathSeparator(path)
      this.forks[path[0]] = new MantarayFork(path, newNode)
      this.makeEdge()

      return
    }

    const commonPath = common(fork.prefix, path)
    const restPath = fork.prefix.slice(commonPath.length)
    let newNode = fork.node

    if (restPath.length > 0) {
      // move current common prefix node
      newNode = new MantarayNode()
      newNode.setObfuscationKey = this.obfuscationKey || (new Uint8Array(32) as Bytes<32>)

      fork.node.updateWithPathSeparator(restPath)
      newNode.forks = {}
      newNode.forks[restPath[0]] = new MantarayFork(restPath, fork.node)
      newNode.makeEdge()

      // if common path is full path new node is value type
      if (path.length === commonPath.length) {
        newNode.makeValue()
      }
    }

    // NOTE: special case on edge split
    newNode.updateWithPathSeparator(path)
    // add new for shared prefix
    newNode.addFork(path.slice(commonPath.length), entry, metadata)
    this.forks[path[0]] = new MantarayFork(commonPath, newNode)
    this.makeEdge()

    this.makeDirty()
  }

  /** removes a path from the node */
  public removePath(path: Uint8Array): void {
    if (path.length === 0) throw EmptyPathError

    if (!this.forks) throw Error(`Fork mapping is not defined in the manifest`)

    const fork = this.forks[path[0]]

    if (!fork) throw NotFoundError

    const prefixIndex = findIndexOfArray(path, fork.prefix)

    if (prefixIndex === -1) throw NotFoundError

    const rest = path.slice(fork.prefix.length)

    if (rest.length === 0) {
      // full path matched
      delete this.forks[path[0]]

      return
    }

    fork.node.removePath(rest)
  }

  public async load(storageLoader: StorageLoader, reference: Reference): Promise<void> {
    if (!reference) throw Error('Reference is undefined at manifest load')

    const data = await storageLoader(reference)
    this.deserialize(data)

    this.setContentAddress = reference
  }

  /**
   * Saves dirty flagged ManifestNode and its forks recursively
   * @returns Reference of the top manifest node.
   */
  public async save(storageSaver: StorageSaver): Promise<Reference> {
    if (this.contentAddress) return this.contentAddress

    // save forks first recursively
    const savePromises: Promise<Reference>[] = []

    if (!this.forks) this.forks = {} // there were no intention to define fork(s)
    for (const fork of Object.values(this.forks)) {
      savePromises.push(fork.node.save(storageSaver))
    }
    await Promise.all(savePromises)

    // save the actual manifest as well
    const data = this.serialize()
    const reference = await storageSaver(data)

    this.setContentAddress = reference

    return reference
  }

  public isDirty(): boolean {
    return this.contentAddress === undefined
  }

  public makeDirty(): void {
    this.contentAddress = undefined
  }

  public serialize(): Uint8Array {
    if (!this.obfuscationKey) this.setObfuscationKey = new Uint8Array(32) as Bytes<32>

    if (!this.forks) {
      if (!this.entry) throw new UndefinedField('entry')
      this.forks = {} //if there were no forks initialized it is not indended to be
    }

    if (!this.entry) this.entry = new Uint8Array(32) as Bytes<32> // at directoties

    /// Header
    const version: MarshalVersion = '0.2'
    const versionBytes: Bytes<31> = serializeVersion(version)
    const referenceLengthBytes: Bytes<1> = serializeReferenceLength(this.entry)

    /// Entry is already in byte version

    /// ForksIndexBytes
    const index = new IndexBytes()
    for (const forkIndex of Object.keys(this.forks)) {
      index.setByte(Number(forkIndex))
    }
    const indexBytes = index.getBytes

    /// Forks
    const forkSerializations: Uint8Array[] = []

    index.forEach(byte => {
      const fork = this.forks![byte]

      if (!fork) throw Error(`Fork indexing error: fork has not found under ${byte} index`)
      forkSerializations.push(fork.serialize())
    })

    const bytes = new Uint8Array([
      ...this.obfuscationKey!,
      ...versionBytes,
      ...referenceLengthBytes,
      ...this.entry,
      ...indexBytes,
      ...flattenBytesArray(forkSerializations),
    ])

    /// Encryption
    /// perform XOR encryption on bytes after obfuscation key
    encryptDecrypt(this.obfuscationKey!, bytes, this.obfuscationKey!.length)

    return bytes
  }

  public deserialize(data: Uint8Array): void {
    const nodeHeaderSize = nodeHeaderSizes.full()

    if (data.length < nodeHeaderSize) throw Error('serialised input too short')

    this.obfuscationKey = new Uint8Array(data.slice(0, nodeHeaderSizes.obfuscationKey)) as Bytes<32>
    // perform XOR decryption on bytes after obfuscation key
    encryptDecrypt(this.obfuscationKey, data, this.obfuscationKey.length)

    const versionHash = data.slice(
      nodeHeaderSizes.obfuscationKey,
      nodeHeaderSizes.obfuscationKey + nodeHeaderSizes.versionHash,
    )

    if (equalBytes(versionHash, serializeVersion('0.1'))) throw NotImplemented
    else if (equalBytes(versionHash, serializeVersion('0.2'))) {
      const refBytesSize = data[nodeHeaderSize - 1]
      const entry = data.slice(nodeHeaderSize, nodeHeaderSize + refBytesSize)
      this.setEntry = entry as Reference
      let offset = nodeHeaderSize + refBytesSize
      const indexBytes = data.slice(offset, offset + 32) as Bytes<32>

      // Currently we don't persist the root nodeType when we marshal the manifest, as a result
      // the root nodeType information is lost on Unmarshal. This causes issues when we want to
      // perform a path 'Walk' on the root. If there is at least 1 fork, the root node type
      // is an edge, so we will deduce this information from index byte array
      if (!equalBytes(indexBytes, new Uint8Array(32))) {
        this.makeEdge()
      }
      this.forks = {}
      const indexForks = new IndexBytes()
      indexForks.setBytes = indexBytes
      offset += 32

      indexForks.forEach(byte => {
        let fork: MantarayFork

        if (data.length < offset + nodeForkSizes.nodeType) {
          throw Error(`There is not enough size to read nodeType of fork at offset ${offset}`)
        }

        const nodeType = data.slice(offset, offset + nodeForkSizes.nodeType)
        let nodeForkSize = nodeForkSizes.preReference + refBytesSize

        if (nodeTypeIsWithMetadataType(nodeType[0])) {
          if (data.length < offset + nodeForkSizes.preReference + refBytesSize + nodeForkSizes.metadata) {
            throw Error(`Not enough bytes for metadata node fork at byte ${byte}`)
          }

          const metadataByteSize = fromBigEndian(
            data.slice(offset + nodeForkSize, offset + nodeForkSize + nodeForkSizes.metadata),
          )
          nodeForkSize += nodeForkSizes.metadata + metadataByteSize

          fork = MantarayFork.deserialize(data.slice(offset, offset + nodeForkSize), this.obfuscationKey!, {
            withMetadata: { refBytesSize, metadataByteSize },
          })
        } else {
          if (data.length < offset + nodeForkSizes.preReference + refBytesSize) {
            throw Error(`There is not enough size to read fork at offset ${offset}`)
          }

          fork = MantarayFork.deserialize(data.slice(offset, offset + nodeForkSize), this.obfuscationKey!)
        }

        this.forks![byte] = fork

        offset += nodeForkSize
      })
    } else {
      throw Error('Wrong mantaray version')
    }
  }
}

export function nodeTypeIsWithMetadataType(nodeType: number): boolean {
  return (nodeType & NodeType.withMetadata) === NodeType.withMetadata
}

/**
 * The hash length has to be 31 instead of 32 that comes from the keccak hash function
 */
function serializeVersion(version: MarshalVersion): Bytes<31> {
  const versionName = 'mantaray'
  const versionSeparator = ':'
  const hashBytes = keccak256Hash(versionName + versionSeparator + version)

  return hashBytes.slice(0, 31) as Bytes<31>
}

function serializeReferenceLength(entry: Reference): Bytes<1> {
  const referenceLength = entry.length

  if (referenceLength !== 32 && referenceLength !== 64) {
    throw new Error(`Wrong referenceLength. It can be only 32 or 64. Got: ${referenceLength}`)
  }
  const bytes = new Uint8Array(1)
  bytes[0] = referenceLength

  return bytes as Bytes<1>
}

/** loads all nodes recursively */
export async function loadAllNodes(storageLoader: StorageLoader, node: MantarayNode): Promise<void> {
  if (!node.forks) return

  for (const fork of Object.values(node.forks)) {
    await fork.node.load(storageLoader, fork.node.getEntry)
    await loadAllNodes(storageLoader, fork.node)
  }
}

/**
 * Throws an error if the given nodes properties are not equal
 *
 * @param a Mantaray node to compare
 * @param b Mantaray node to compare
 * @param accumulatedPrefix accumulates the prefix during the recursion
 * @throws Error if the two nodes properties are not equal recursively
 */
export const equalNodes = (a: MantarayNode, b: MantarayNode, accumulatedPrefix = ''): void | never => {
  if (a.getType !== b.getType) {
    throw Error(`Nodes do not have same type at prefix "${accumulatedPrefix}"\na: ${a.getType} <-> b: ${b.getType}`)
  }

  if (!a.forks) return

  const aKeys = Object.keys(a.forks)

  if (!b.forks || aKeys.length !== Object.keys(b.forks).length) {
    throw Error(`Nodes do not have same fork length on equality check at prefix ${accumulatedPrefix}`)
  }

  for (const key of aKeys) {
    const aFork: MantarayFork = a.forks[Number(key)]
    const bFork: MantarayFork = b.forks[Number(key)]
    const prefix = aFork.prefix

    if (!equalBytes(prefix, bFork.prefix)) {
      throw Error(`Nodes do not have same prefix under the same key "${key}" at prefix ${accumulatedPrefix}`)
    }

    equalNodes(aFork.node, bFork.node, accumulatedPrefix + prefix)
  }
}