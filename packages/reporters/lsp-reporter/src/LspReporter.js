// @flow strict-local
/* eslint-disable no-console */

import type {Diagnostic as ParcelDiagnostic} from '@parcel/diagnostic';
import type {PackagedBundle, FilePath, BundleGraph} from '@parcel/types';
import type {Program, Query} from 'ps-node';

import {DiagnosticSeverity} from 'vscode-languageserver/node';

import {
  DefaultMap,
  getProgressMessage,
  makeDeferredWithPromise,
} from '@parcel/utils';
import {Reporter} from '@parcel/plugin';
import invariant from 'assert';
import path from 'path';
import os from 'os';
import fs from 'fs';
import url from 'url';
import * as ps from 'ps-node';
import {promisify} from 'util';
import ipc from 'node-ipc';
import nullthrows from 'nullthrows';

const lookupPid: Query => Program[] = promisify(ps.lookup);

// flowlint-next-line unclear-type:off
type LspDiagnostic = any;

type ParcelSeverity = 'error' | 'warn' | 'info' | 'verbose';

let watchEnded = false;
let fileDiagnostics: DefaultMap<string, Array<LspDiagnostic>> = new DefaultMap(
  () => [],
);
let pipeFilename;

let lastBundleGraph = makeDeferredWithPromise<BundleGraph<PackagedBundle>>();

export default (new Reporter({
  async report({event, logger, options}) {
    switch (event.type) {
      case 'watchStart': {
        let transportName = `parcel-${process.pid}`;
        ipc.config.id = transportName;
        ipc.config.retry = 1500;
        ipc.config.logger = message => logger.verbose({message});
        ipc.serve(() => {
          ipc.server.on('init', (_, socket) => {
            ipc.server.emit(socket, 'message', {
              type: 'parcelFileDiagnostics',
              fileDiagnostics: [...fileDiagnostics],
            });
            ipc.server.on('connect', () => {
              ipc.server.emit(socket, 'message', {
                type: 'parcelFileDiagnostics',
                fileDiagnostics: [...fileDiagnostics],
              });
            });
          });
          // $FlowFixMe event handler cannot be async?
          ipc.server.on(
            'onDefinition',
            async ({document, word, position, id}, socket) => {
              let bundleGraph = await lastBundleGraph.promise;
              let result = onDefinition(bundleGraph, document, word, position);
              ipc.server.emit(socket, 'onDefinition', {
                id,
                document: result?.document,
                range: result?.range,
              });
            },
          );
        });
        ipc.server.start();

        // Create a file to ID the transport
        let pathname = path.join(os.tmpdir(), 'parcel-lsp');
        await fs.promises.mkdir(pathname, {recursive: true});

        // For each existing file, check if the pid matches a running process.
        // If no process matches, delete the file, assuming it was orphaned
        // by a process that quit unexpectedly.
        for (let filename of fs.readdirSync(pathname)) {
          let pid = parseInt(filename, 10);
          let resultList = await lookupPid({pid});
          if (resultList.length) continue;
          fs.unlinkSync(path.join(pathname, filename));
        }

        pipeFilename = path.join(pathname, String(process.pid));
        await fs.promises.writeFile(
          pipeFilename,
          JSON.stringify({
            transportName,
            pid: process.pid,
            argv: process.argv,
          }),
        );

        console.debug('connection listening...');

        if (watchEnded) {
          ipc.server.stop();
          invariant(pipeFilename);
          fs.unlinkSync(pipeFilename);
        } else if (fileDiagnostics.size > 0) {
          ipc.server.broadcast('message', {
            type: 'parcelFileDiagnostics',
            fileDiagnostics: [...fileDiagnostics],
          });
        }
        break;
      }
      case 'buildStart': {
        ipc.server.broadcast('message', {type: 'parcelBuildStart'});
        ipc.server.broadcast('message', {
          type: 'parcelFileDiagnostics',
          fileDiagnostics: [...fileDiagnostics].map(([uri]) => [uri, []]),
        });
        fileDiagnostics.clear();
        lastBundleGraph = makeDeferredWithPromise();
        break;
      }
      case 'buildSuccess':
        ipc.server.broadcast('message', {type: 'parcelBuildSuccess'});
        ipc.server.broadcast('message', {
          type: 'parcelFileDiagnostics',
          fileDiagnostics: [...fileDiagnostics],
        });
        lastBundleGraph.deferred.resolve(event.bundleGraph);
        break;
      case 'buildFailure': {
        updateDiagnostics(
          fileDiagnostics,
          event.diagnostics,
          'error',
          options.projectRoot,
        );
        ipc.server.broadcast('message', {type: 'parcelBuildEnd'});
        ipc.server.broadcast('message', {
          type: 'parcelFileDiagnostics',
          fileDiagnostics: [...fileDiagnostics],
        });
        break;
      }
      case 'log':
        if (
          event.diagnostics != null &&
          (event.level === 'error' ||
            event.level === 'warn' ||
            event.level === 'info' ||
            event.level === 'verbose')
        ) {
          updateDiagnostics(
            fileDiagnostics,
            event.diagnostics,
            event.level,
            options.projectRoot,
          );
        }
        break;
      case 'buildProgress': {
        let message = getProgressMessage(event);
        if (message != null) {
          ipc.server.broadcast('message', {
            type: 'parcelBuildProgress',
            message,
          });
        }
        break;
      }
      case 'watchEnd':
        watchEnded = true;
        if (pipeFilename != null) {
          fs.unlinkSync(pipeFilename);
        }
        ipc.server.stop();
        console.debug('connection disposed of');
        break;
    }
  },
}): Reporter);

function updateDiagnostics(
  fileDiagnostics: DefaultMap<string, Array<LspDiagnostic>>,
  parcelDiagnostics: Array<ParcelDiagnostic>,
  parcelSeverity: ParcelSeverity,
  projectRoot: FilePath,
): void {
  for (let diagnostic of parcelDiagnostics) {
    const codeFrames = diagnostic.codeFrames;
    if (codeFrames == null) {
      continue;
    }

    const firstCodeFrame = codeFrames[0];
    const filePath = firstCodeFrame.filePath;
    if (filePath == null) {
      continue;
    }

    // We use the first highlight of the first codeFrame as the main Diagnostic,
    // and we place everything else in the current Parcel diagnostic
    // in relatedInformation
    // https://code.visualstudio.com/api/references/vscode-api#DiagnosticRelatedInformation
    const firstFrameHighlight = codeFrames[0].codeHighlights[0];
    if (firstFrameHighlight == null) {
      continue;
    }

    const relatedInformation = [];
    for (const codeFrame of codeFrames) {
      for (const highlight of codeFrame.codeHighlights) {
        const filePath = codeFrame.filePath;
        if (highlight === firstFrameHighlight || filePath == null) {
          continue;
        }

        relatedInformation.push({
          location: {
            uri: `file://${normalizeFilePath(filePath, projectRoot)}`,
            range: {
              start: {
                line: highlight.start.line - 1,
                character: highlight.start.column - 1,
              },
              end: {
                line: highlight.end.line - 1,
                character: highlight.end.column,
              },
            },
          },
          message: highlight.message ?? diagnostic.message,
        });
      }
    }

    fileDiagnostics
      .get(`file://${normalizeFilePath(filePath, projectRoot)}`)
      .push({
        range: {
          start: {
            line: firstFrameHighlight.start.line - 1,
            character: firstFrameHighlight.start.column - 1,
          },
          end: {
            line: firstFrameHighlight.end.line - 1,
            character: firstFrameHighlight.end.column,
          },
        },
        source: diagnostic.origin,
        severity: parcelSeverityToLspSeverity(parcelSeverity),
        message:
          diagnostic.message +
          (firstFrameHighlight.message == null
            ? ''
            : ' ' + firstFrameHighlight.message),
        relatedInformation,
      });
  }
}

function parcelSeverityToLspSeverity(parcelSeverity: ParcelSeverity): mixed {
  switch (parcelSeverity) {
    case 'error':
      return DiagnosticSeverity.Error;
    case 'warn':
      return DiagnosticSeverity.Warning;
    case 'info':
      return DiagnosticSeverity.Information;
    case 'verbose':
      return DiagnosticSeverity.Hint;
    default:
      throw new Error('Unknown severity');
  }
}

function normalizeFilePath(filePath: FilePath, projectRoot: FilePath) {
  return path.isAbsolute(filePath)
    ? filePath
    : path.join(projectRoot, filePath);
}

function onDefinition(
  bundleGraph: BundleGraph<PackagedBundle>,
  document: string,
  word: string,
  // eslint-disable-next-line no-unused-vars
  position: {|line: number, character: number|},
) {
  let assetFileName = url.fileURLToPath(document);
  let ext = path.extname(assetFileName).slice(1);
  let asset = nullthrows(
    bundleGraph.traverseBundles((bundle, context, actions) => {
      let asset = bundle.traverseAssets((asset, context, actions) => {
        if (asset.filePath === assetFileName && asset.type === ext) {
          actions.stop();
          return asset;
        }
      });
      if (asset) {
        actions.stop();
        return asset;
      }
    }),
  );

  for (let dep of asset.getDependencies()) {
    if (dep.symbols.hasLocalSymbol(word)) {
      for (let [sym, symbol] of dep.symbols) {
        if (symbol.local === word) {
          let resolution = bundleGraph.getSymbolResolution(
            nullthrows(bundleGraph.getResolvedAsset(dep)),
            sym,
          );
          if (resolution) {
            return {
              document: url.pathToFileURL(resolution.asset.filePath).href,
              range: {
                start: {
                  line: nullthrows(resolution.loc).start.line - 1,
                  character: nullthrows(resolution.loc).start.column - 1,
                },
                end: {
                  line: nullthrows(resolution.loc).end.line - 1,
                  character: nullthrows(resolution.loc).end.column,
                },
              },
            };
          }
        }
      }
    }
  }
}
