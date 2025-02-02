import { Bee, FileUploadOptions, Reference } from '@ethersphere/bee-js'
import FS from 'fs'
import { join } from 'path'
import { MantarayNode } from '../src'
import { loadAllNodes } from '../src/node'
import { commonMatchers, getSampleMantarayNode } from './utils'
import { execSync } from 'child_process'

commonMatchers()
const beeUrl = process.env.BEE_API_URL || 'http://localhost:1633'
const stamp = process.env.BEE_POSTAGE || 'dummystamp'
const bee = new Bee(beeUrl)

const utf8ToBytes = (value: string): Uint8Array => {
  return new TextEncoder().encode(value)
}

const saveFunction = async (data: Uint8Array, options?: { ecrypt?: boolean }): Promise<Reference> => {
  const uploadOptions: FileUploadOptions = {
    encrypt: options?.ecrypt
  }
  const hexRef = await bee.uploadData(stamp, data, uploadOptions)
  return hexRef.reference
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

  const iNode = new MantarayNode()
  iNode.addFork(utf8ToBytes('index.html'), indexReference as Reference, {
    'Content-Type': 'text/html; charset=utf-8',
    Filename: 'index.html',
  })
  iNode.addFork(utf8ToBytes('img/icon.png.txt'), textReference as Reference, {
    'Content-Type': 'text/plain; charset=utf-8',
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
  const iNodeRes = await iNode.save(saveFunction)

  // sanity check
  expect(uploadResult.reference).toEqual('ac9f347091bec7ea23fbf6f5786134bd6cb3b89a32ba47e6a1c06fa36caecf41')

  expect(iNodeRes).toEqual(uploadResult.reference)
})

it('should serialize/deserialize the same as Bee', async () => {
  const data = await beeTestPageManifestData()
  const node = new MantarayNode()
  node.deserialize(data)
  await loadAllNodes(loadFunction, node)
  const serialization = node.serialize()
  expect(serialization instanceof Uint8Array).toBe(true)
  expect(data instanceof Uint8Array).toBe(true)
  expect(Array.from(serialization)).toEqual(Array.from(data))
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
    'Content-Type': 'text/plain; charset=utf-8',
    Filename: 'icon.png.txt',
  })
  iNode.addFork(utf8ToBytes('img/icon.png'), imageReference as Reference, {
    'Content-Type': 'image/png',
    Filename: 'icon.png',
  })
  iNode.addFork(utf8ToBytes('/'), '0'.repeat(64) as Reference, {
    'website-index-document': 'index.html',
  })
  const reference = await iNode.save(saveFunction)
  expect(Object.keys(iNode.forks || {})).toStrictEqual(Object.keys(node.forks || {}))
  const marshal = iNode.serialize()
  const iNodeAgain = new MantarayNode()
  iNodeAgain.deserialize(marshal)
  await loadAllNodes(loadFunction, iNodeAgain)

  // check after serialization the object is same
  expect(iNode).toBeEqualNode(iNodeAgain)
  // check bee manifest is equal with the constructed one.
  expect(iNode).toBeEqualNode(node)
  // eslint-disable-next-line no- le
  console.log('Constructed root manifest hash', reference)
})

it('should remove fork then upload it', async () => {
  const sampleNode = getSampleMantarayNode()
  const node = sampleNode.node
  const path1 = sampleNode.paths[0]
  const path2 = sampleNode.paths[1]
  // save sample node
  const refOriginal = await node.save(saveFunction)
  //node where the fork set will change 
  const getCheckNode = (): MantarayNode => {
    return node.getForkAtPath(new TextEncoder().encode('path1/valami/')).node
  }
  const checkNode1 = getCheckNode()
  const refCheckNode1 = checkNode1.getContentAddress
  // current forks of node
  expect(Object.keys(checkNode1.forks || {})).toStrictEqual([String(path1[13]), String(path2[13])])
  node.removePath(path2)
  const reference = await node.save(saveFunction)
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

it('should modify the tree and call save on the mantaray root then load it back correctly', async () => {
  const data = await beeTestPageManifestData()
  const node = new MantarayNode()
  node.deserialize(data)
  await loadAllNodes(loadFunction, node)

  // it modifies a node value and then 2 levels above a descendant node

  const firstNode = node.forks![105].node
  const descendantNode = firstNode.forks![109].node.forks![46].node
  firstNode.setMetadata = {
    ...firstNode.getMetadata,
    additionalParam: 'first',
  }
  descendantNode.setMetadata = {
    ...descendantNode.getMetadata,
    additionalParam: 'second',
  }

  const saveRef = await node.save(saveFunction)
  const nodeAgain = new MantarayNode()
  await nodeAgain.load(loadFunction, saveRef)
  await loadAllNodes(loadFunction, nodeAgain)
  const firstNodeAgain = nodeAgain.forks![105].node
  const descendantNodeAgain = firstNodeAgain.forks![109].node.forks![46].node

  expect(firstNodeAgain.getMetadata).toStrictEqual(firstNode.getMetadata)
  expect(firstNodeAgain.getMetadata!.additionalParam).toBe('first')
  // fails if the save does not walk the whole tree
  expect(descendantNodeAgain.getMetadata).toStrictEqual(descendantNode.getMetadata)
  expect(descendantNodeAgain.getMetadata!.additionalParam).toBe('second')
})

it('should upload the correct content with correct path', async () => {
  const indexPath = 'testpage/index.html';
  const indexBytes = FS.readFileSync(join(__dirname, indexPath));
  const uploadRes = await uploadData(indexBytes);
  const iconPath = 'testpage/img/icon.png';
  const iconBytes = FS.readFileSync(join(__dirname, iconPath));
  const iconRes = await uploadData(iconBytes)
  
  const mantaray = new MantarayNode();

  mantaray.addFork(utf8ToBytes(indexPath), uploadRes as Reference, {
    'Content-Type': 'text/plain; charset=utf-8',
    Filename: 'utils.ts',
  });

  mantaray.addFork(utf8ToBytes(iconPath), iconRes as Reference, {
    'Content-Type': 'image/png',
    Filename: 'icon.png',
  })

  const saveResult = await mantaray.save(saveFunction);

  const downloadPath = `/tmp/${saveResult}`;
  execSync(`swarm-cli manifest download ${saveResult} ${downloadPath}`);
  
  // Validate folder structure
  expect(FS.existsSync(join(downloadPath, iconPath))).toBe(true);
  expect(FS.existsSync(join(downloadPath, indexPath))).toBe(true);

  // Validate file contents
  const downloadedIconBytes = FS.readFileSync(join(downloadPath, iconPath));
  expect(Buffer.compare(downloadedIconBytes, iconBytes)).toBe(0);

  const downloadedIndexBytes = FS.readFileSync(join(downloadPath, indexPath));
  expect(Buffer.compare(downloadedIndexBytes, indexBytes)).toBe(0);
})