/* eslint-disable no-console */
/*
 * For a detailed explanation regarding each configuration property and type check, visit:
 * https://jestjs.io/docs/en/configuration.html
 */
import { Bee } from '@ethersphere/bee-js'
import type { Config } from '@jest/types'

export default async (): Promise<Config.InitialOptions> => {
  if (!process.env.BEE_POSTAGE) {
    try {
      console.log('Creating postage stamps...')
      const beeUrl = process.env.BEE_API_URL || 'http://localhost:1633'
      const bee = new Bee(beeUrl)
      process.env.BEE_POSTAGE = await bee.createPostageBatch('414720000', 20, {
        waitForUsable: true,
        waitForUsableTimeout: 120_000,
      })
      console.log('Queen stamp: ', process.env.BEE_POSTAGE)
    } catch (e) {
      // It is possible that for unit tests the Bee nodes does not run
      // so we are only logging errors and not leaving them to propagate
      console.error(e)
    }
  }

  return {
    // Indicates whether the coverage information should be collected while executing the test
    // collectCoverage: false,

    // The directory where Jest should output its coverage files
    coverageDirectory: 'coverage',

    // An array of regexp pattern strings used to skip coverage collection
    coveragePathIgnorePatterns: ['/node_modules/'],

    // An array of directory names to be searched recursively up from the requiring module's location
    moduleDirectories: ['node_modules'],

    // The root directory that Jest should scan for tests and modules within
    rootDir: 'test',

    testEnvironment: 'node',
    testRegex: 'test/.*\\.spec\\.ts',

    // An array of regexp pattern strings that are matched against all test paths, matched tests are skipped
    testPathIgnorePatterns: ['/node_modules/'],

    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

    transform: {
      '^.+\\.ts?$': 'ts-jest', 
    },

    preset: 'ts-jest',
  }
}
