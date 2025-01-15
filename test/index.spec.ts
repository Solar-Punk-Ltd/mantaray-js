import { Bee, Reference, Utils } from '@ethersphere/bee-js'
import FS from 'fs'
import { join } from 'path'
import { MantarayNode } from '../src'
import { loadAllNodes } from '../src/node'
import { commonMatchers, getSampleMantarayNode } from './utils'

commonMatchers()
const beeUrl = process.env.BEE_API_URL || 'http://localhost:1633'
const stamp = process.env.BEE_POSTAGE || 'dummystamp'
const bee = new Bee(beeUrl)

const hexToBytes = (hexString: string): Uint8Array => {
  return Utils.hexToBytes(hexString)
}

const saveFunction = async (data: Uint8Array): Promise<{ reference: Reference, actReference: Reference | null }> => {
  const hexRef = await bee.uploadData(stamp, data)

  return { reference: hexRef.reference, actReference: null }
}

const loadFunction = async (address: Reference): Promise<Uint8Array> => {
  return bee.downloadData(address)
}

const uploadData = async (data: Uint8Array): Promise<string> => {
  const result = await bee.uploadData(stamp, data)

  return result.reference
}

/** Uploads the testpage directory with bee-js and return back its root manifest data */
const beeTestPageManifestData = async (): Promise<Uint8Array> => {
  const uploadResult = await bee.uploadFilesFromDirectory(stamp, join(__dirname, 'testpage'), {
    pin: true,
    indexDocument: 'index.html',
  })

  return bee.downloadData(uploadResult.reference) //only download its manifest
}

it('should generate the same content hash as Bee', async () => {
  const testDir = join(__dirname, 'testpage')
  const uploadResult = await bee.uploadFilesFromDirectory(stamp, testDir, {
    pin: true,
    indexDocument: 'index.html',
  })
  const testPage = join(__dirname, 'testpage')
  const indexHtmlBytes = FS.readFileSync(join(testPage, 'index.html'))
  const imageBytes = FS.readFileSync(join(testPage, 'img', 'icon.png'))
  const textBytes = FS.readFileSync(join(testPage, 'img', 'icon.png.txt'))
  const [indexReference, imageReference, textReference] = await Promise.all([
    uploadData(indexHtmlBytes),
    uploadData(imageBytes),
    uploadData(textBytes),
  ])
  const utf8ToBytes = (value: string): Uint8Array => {
    return new TextEncoder().encode(value)
  }
  const iNode = new MantarayNode()
  iNode.addFork(utf8ToBytes('index.html'), indexReference as Reference, {
    'Content-Type': 'text/html; charset=utf-8',
    Filename: 'index.html',
  })
  iNode.addFork(utf8ToBytes('img/icon.png.txt'), textReference as Reference, {
    'Content-Type': '',
    Filename: 'icon.png.txt',
  })
  iNode.addFork(utf8ToBytes('img/icon.png'), imageReference as Reference, {
    'Content-Type': 'image/png',
    Filename: 'icon.png',
  })
  const websiteIndReference = '0'.repeat(64) as Reference;
  iNode.addFork(utf8ToBytes('/'), websiteIndReference, {
    'website-index-document': 'index.html',
  })
  const { reference } = await iNode.save(saveFunction)

  // sanity check
  expect(uploadResult.reference).toEqual('e9d46950cdb17e15d0b3712bcb325724a3107560143d65a7acd00ea781eb9cd7')

  expect(reference).toEqual(hexToBytes(uploadResult.reference))
})

it('should serialize/deserialize the same as Bee', async () => {
  const data = await beeTestPageManifestData()
  const node = new MantarayNode()
  node.deserialize(data)
  await loadAllNodes(loadFunction, node)
  const serialization = node.serialize()
  expect(serialization).toEqual(data)
  const nodeAgain = new MantarayNode()
  nodeAgain.deserialize(serialization)
  await loadAllNodes(loadFunction, nodeAgain)
  expect(nodeAgain).toStrictEqual(node)
})

it('should construct manifests of testpage folder', async () => {
  const data = await beeTestPageManifestData()
  const node = new MantarayNode()
  node.deserialize(data)
  await loadAllNodes(loadFunction, node)

  const testPage = join(__dirname, 'testpage')
  const indexHtmlBytes = FS.readFileSync(join(testPage, 'index.html'))
  const imageBytes = FS.readFileSync(join(testPage, 'img', 'icon.png'))
  const [indexReference, imageReference, textReference] = await Promise.all([
    uploadData(indexHtmlBytes),
    uploadData(imageBytes),
    uploadData(new Uint8Array([104, 97, 108, 105])),
  ])
  const utf8ToBytes = (value: string): Uint8Array => {
    return new TextEncoder().encode(value)
  }
  const iNode = new MantarayNode()
  iNode.addFork(utf8ToBytes('index.html'), indexReference as Reference, {
    'Content-Type': 'text/html; charset=utf-8',
    Filename: 'index.html',
  })
  iNode.addFork(utf8ToBytes('img/icon.png.txt'), textReference as Reference, {
    'Content-Type': '',
    Filename: 'icon.png.txt',
  })
  iNode.addFork(utf8ToBytes('img/icon.png'), imageReference as Reference, {
    'Content-Type': 'image/png',
    Filename: 'icon.png',
  })
  iNode.addFork(utf8ToBytes('/'), '0x' + '0'.repeat(64) as Reference, {
    'website-index-document': 'index.html',
  })
  const { reference } = await iNode.save(saveFunction)
  expect(Object.keys(iNode.forks || {})).toStrictEqual(Object.keys(node.forks || {}))
  const marshal = iNode.serialize()
  const iNodeAgain = new MantarayNode()
  iNodeAgain.deserialize(marshal)
  await loadAllNodes(loadFunction, iNodeAgain)
  // check after serialization the object is same
  expect(iNode).toBeEqualNode(iNodeAgain)
  // check bee manifest is equal with the constructed one.
  expect(iNode).toBeEqualNode(node)
  // eslint-disable-next-line no-console
  console.log('Constructed root manifest hash', reference)
})

it('should remove fork then upload it', async () => {
  const sampleNode = getSampleMantarayNode()
  const node = sampleNode.node
  const path1 = sampleNode.paths[0]
  const path2 = sampleNode.paths[1]
  // save sample node
  const refOriginal = await node.save(saveFunction)
  /** node where the fork set will change */
  const getCheckNode = (): MantarayNode => {
    return node.getForkAtPath(new TextEncoder().encode('path1/valami/')).node
  }
  const checkNode1 = getCheckNode()
  const refCheckNode1 = checkNode1.getContentAddress
  // current forks of node
  expect(Object.keys(checkNode1.forks || {})).toStrictEqual([String(path1[13]), String(path2[13])])
  node.removePath(path2)
  const { reference } = await node.save(saveFunction)
  // root reference should not remain the same
  expect(reference).not.toStrictEqual(refOriginal)
  node.load(loadFunction, reference)
  // 'm' key of prefix table disappeared
  const checkNode2 = getCheckNode()
  expect(Object.keys(checkNode2.forks || {})).toStrictEqual([String(path1[13])])
  // reference should differ because the changed fork set
  const refCheckNode2 = checkNode2.getContentAddress
  expect(refCheckNode2).not.toStrictEqual(refCheckNode1)
})
/*
it('should modify the tree and call save on the mantaray root then load it back correctly', async () => {
  const data = await beeTestPageManifestData()
  const node = new MantarayNode()
  node.deserialize(data)
  await loadAllNodes(loadFunction, node)

  // it modifies a node value and then 2 levels above a descendant node
if (!node.forks) throw "forks is null or undefined"

  const firstNode = node.forks[105].node
  const descendantNode = firstNode.forks[109].node.forks[46].node
  firstNode.setMetadata = {
    ...firstNode.getMetadata,
    additionalParam: 'first',
  }
  descendantNode.setMetadata = {
    ...descendantNode.getMetadata,
    additionalParam: 'second',
  }

  const { reference } = await node.save(saveFunction)
  const nodeAgain = new MantarayNode()
  await nodeAgain.load(loadFunction, reference)
  await loadAllNodes(loadFunction, nodeAgain)
  const firstNodeAgain = nodeAgain.forks[105].node
  const descendantNodeAgain = firstNodeAgain.forks[109].node.forks[46].node

  expect(firstNodeAgain.getMetadata).toStrictEqual(firstNode.getMetadata)
  expect(firstNodeAgain.getMetadata.additionalParam).toBe('first')
  // fails if the save does not walk the whole tree
  expect(descendantNodeAgain.getMetadata).toStrictEqual(descendantNode.getMetadata)
  expect(descendantNodeAgain.getMetadata.additionalParam).toBe('second')
})
*/