import { base64ToU8, concatenateChunks, EventEmitterLike, MAX_INT32_VALUE } from 'googlevideo/utils'
import { UmpReader } from 'googlevideo/ump'
import {
  UMPPartId,
  VideoPlaybackAbrRequest,
  StreamProtectionStatus,
  SabrError,
  SabrRedirect,
  MediaHeader,
  SabrContextSendingPolicy,
  SabrContextUpdate,
  SabrContextWritePolicy,
  NextRequestPolicy,
  ReloadPlaybackContext,
} from 'googlevideo/protos'
import shaka from 'shaka-player'

import { deepCopy } from '../utils'

const AbortableOperation = shaka.util.AbortableOperation
const ShakaError = shaka.util.Error

const SABR_DIAGNOSTICS = process.env.NODE_ENV === 'development'

const diagnosticPostTimestamps = []
let diagnosticTotalPostCount = 0
let diagnosticSessionBreakoutCount = 0
let diagnosticLastRateLogTime = 0

/**
 * Dev-only instrumentation: records a ustreamer POST in a sliding 60 s window so the
 * burst size of NRP-retry loops is observable in the console of development builds.
 * Release builds contain none of this (dead-code eliminated by webpack).
 */
function recordSabrDiagnosticPost() {
  const now = Date.now()
  while (diagnosticPostTimestamps.length > 0 && now - diagnosticPostTimestamps[0] > 60000) {
    diagnosticPostTimestamps.shift()
  }
  diagnosticPostTimestamps.push(now)
  diagnosticTotalPostCount += 1

  // Snapshot when the per-minute rate is noteworthy, at most once every 10 s
  if (diagnosticPostTimestamps.length >= 30 && now - diagnosticLastRateLogTime > 10000) {
    diagnosticLastRateLogTime = now
    // eslint-disable-next-line no-console
    console.info(`[SABR] ustreamer POST rate: ${diagnosticPostTimestamps.length}/min (60 s sliding window), ${diagnosticTotalPostCount} total this session`)
  }
}

/**
 * Dev-only instrumentation: logs the state that caused a control-plane breakout
 * (fake reload or server-ordered reload).
 * @param {string} reason
 * @param {CurrentState} currentState
 */
function logSabrDiagnosticBreakout(reason, currentState) {
  diagnosticSessionBreakoutCount += 1

  const now = Date.now()
  while (diagnosticPostTimestamps.length > 0 && now - diagnosticPostTimestamps[0] > 60000) {
    diagnosticPostTimestamps.shift()
  }

  // eslint-disable-next-line no-console
  console.info(
    `[SABR] breakout ${diagnosticSessionBreakoutCount} (${reason}): ` +
    `${diagnosticPostTimestamps.length}/min POSTs (60 s window), ${diagnosticTotalPostCount} session total; ` +
    `op: ${currentState.cumulativeRetryDueToNextRequestPolicy} NRP retries, ` +
    `${currentState.cumulativeBackOffRequested} backoffs (cumulative ${currentState.cumulativeBackOffTimeMs} ms), ` +
    `${currentState.flooredBackoffWaitCount} floored waits, ` +
    `${currentState.cumulativeRedirects} redirects, ` +
    `${currentState.receivedMediaBytes} media bytes received this op`
  )
}

/**
 * @typedef OperationInputs
 * @type {object}
 * @property {string} uri
 * @property {shaka.extern.Request} request
 * @property {shaka.net.NetworkingEngine.RequestType} requestType
 * @property {shaka.extern.HeadersReceived} headersReceived
 * The following are calculated from above properties
 * @property {string} formatIdString
 * @property {boolean} isInit
 * @property {number} sequenceNumber
 */
/**
 * @typedef AbortStatus
 * @type {object}
 * @property {boolean} cancelled
 * @property {boolean} timedOut
 * @property {boolean} playerReloadRequested
 * @property {boolean} finished
 */
/**
 * @typedef CurrentState
 * @type {object}
 * @property {Map<string, Uint8Array>} initDataCache
 * @property {VideoPlaybackAbrRequest} abrRequest
 * @property {RequestInit} requestInit
 * @property {AbortStatus} abortStatus
 * @property {AbortController} abortController
 * @property {SabrStreamState} sabrStreamState
 * @property {?TimeoutController} timeoutController
 * @property {?EventEmitterLike} eventEmitter
 * @property {number} cumulativeBackOffTimeMs
 * @property {number} cumulativeBackOffRequested
 * @property {number} cumulativeRetryDueToNextRequestPolicy
 * @property {number} cumulativeRedirects
 * @property {number} flooredBackoffWaitCount
 * @property {number} receivedMediaBytes
 */
/**
 * @typedef SabrStreamState
 * @type {object}
 * @property {string} sabrUrl
 * @property {Set<number>} activeSabrContextTypes
 * @property {Map<number, SabrContextUpdate>} sabrContexts
 * @property {?NextRequestPolicy} nextRequestPolicy
 * @property {boolean} playerReloadRequested
 * @property {number} requestNumber
 */
/**
 * @typedef TimeoutController
 * @type {object}
 * @property {() => void} resetTimeoutOnce
 * @property {() => void} clearTimeout
 */
/**
 * @typedef SabrStream
 * @type {object}
 * @property {(cb: ({backoffMs: number}) => void) => void} onBackoffRequested
 * @property {(cb: () => void) => void} onReloadOnce
 * @property {() => void | undefined} cleanup
 */

/**
 * @param {string} str
 */
function formatIdFromString(str) {
  const videoFormatIdParts = str.split('-')

  return {
    itag: parseInt(videoFormatIdParts[0]),
    lastModified: videoFormatIdParts[1],
    xtags: videoFormatIdParts[2].length === 0 ? undefined : videoFormatIdParts[2]
  }
}

/**
 * @param {import('googlevideo/protos').FormatId} formatId
 * @param {shaka.extern.BufferedRange} buffered
 * @param {shaka.media.SegmentIndex} segmentIndex
 */
function createBufferedRange(formatId, buffered, segmentIndex) {
  let endSegmentIndex = segmentIndex.find(buffered.end)
  if (endSegmentIndex == null) {
    // Using Last end time will get `null` in `segmentIndex.find`
    endSegmentIndex = segmentIndex.getNumReferences() - 1
  }

  return {
    formatId,
    startTimeMs: String(Math.round(buffered.start * 1000)),
    durationMs: String(Math.round((buffered.end - buffered.start) * 1000)),
    startSegmentIndex: segmentIndex.find(buffered.start),
    endSegmentIndex: endSegmentIndex,
  }
}

/**
 * Creates a bogus buffered range for a format. Used when we want to signal to the server to not send any
 * segments for this format.
 * @param {import('googlevideo/protos').FormatId} formatId - The format to create a full buffer range for.
 * @returns {import('googlevideo/protos').BufferedRange} A BufferedRange object indicating the entire format is buffered.
 */
function createFullBufferRange(formatId) {
  return {
    formatId: formatId,
    durationMs: MAX_INT32_VALUE,
    startTimeMs: '0',
    startSegmentIndex: parseInt(MAX_INT32_VALUE),
    endSegmentIndex: parseInt(MAX_INT32_VALUE),
    timeRange: {
      durationTicks: MAX_INT32_VALUE,
      startTicks: '0',
      timescale: 1000
    }
  }
}

/**
 * @param {shaka.Player} player
 * @param {shaka.extern.Manifest} manifest
 * @param {boolean} audioFormatsActive
 * @param {boolean} streamIsVideo - Fake audio bufferRange can be used
 * @param {boolean} streamIsAudio - Fake video bufferRange can be used
 * @param {import('googlevideo/protos').BufferedRange[]} bufferedRanges
 * @param {shaka.extern.Track} activeVariant
 */
function fillBufferedRanges(player, manifest, audioFormatsActive, streamIsVideo, streamIsAudio, bufferedRanges, activeVariant) {
  const bufferedInfo = player.getBufferedInfo()

  if (bufferedInfo.audio.length > 0 || bufferedInfo.video.length > 0) {
    let activeManifestVariant
    if (audioFormatsActive) {
      activeManifestVariant = manifest.variants.find((variant) => {
        return variant.audio.originalId === activeVariant.originalAudioId
      })
    } else {
      activeManifestVariant = manifest.variants.find((variant) => {
        return variant.audio.originalId === activeVariant.originalAudioId &&
          variant.video.originalId === activeVariant.originalVideoId
      })
    }

    const audioFormatId = formatIdFromString(activeVariant.originalAudioId)
    const audioSegmentIndex = activeManifestVariant.audio.segmentIndex

    if (streamIsVideo) {
      bufferedRanges.push(createFullBufferRange(audioFormatId))
    } else {
      for (const buffered of bufferedInfo.audio) {
        bufferedRanges.push(createBufferedRange(audioFormatId, buffered, audioSegmentIndex))
      }
    }

    // Lazily initialize these variables as video data won't exist for audio-only playback
    let videoFormatId
    let videoSegmentIndex

    if (streamIsAudio && bufferedInfo.video.length > 0) {
      videoFormatId = formatIdFromString(activeVariant.originalVideoId)
      bufferedRanges.push(createFullBufferRange(videoFormatId))
    } else {
      for (const buffered of bufferedInfo.video) {
        if (!videoFormatId) {
          videoFormatId = formatIdFromString(activeVariant.originalVideoId)
        }

        if (!videoSegmentIndex) {
          videoSegmentIndex = activeManifestVariant.video.segmentIndex
        }

        bufferedRanges.push(createBufferedRange(videoFormatId, buffered, videoSegmentIndex))
      }
    }
  }
}

/**
 * @param {string} uri
 * @param {shaka.extern.Request} request
 * @param {Uint8Array} data
 * @returns {shaka.util.AbortableOperation<shaka.extern.Response>}
 */
function createCacheResponse(uri, request, data) {
  return AbortableOperation.completed({
    data,
    fromCache: true,
    headers: {},
    originalRequest: request,
    originalUri: uri,
    uri
  })
}

/**
 * @param {shaka.util.Error.Code} code
 * @param {...any} args
 */
function createRecoverableNetworkError(code, ...args) {
  return new ShakaError(ShakaError.Severity.RECOVERABLE, ShakaError.Category.NETWORK, code, ...args)
}

/**
 * @param {SabrStreamState} sabrStreamState
 */
function prepareSabrContexts(sabrStreamState) {
  /** @type {SabrContextUpdate[]} */
  const sabrContexts = []
  /** @type {number[]} */
  const unsentSabrContexts = []

  for (const ctxUpdate of sabrStreamState.sabrContexts.values()) {
    if (sabrStreamState.activeSabrContextTypes.has(ctxUpdate.type)) {
      sabrContexts.push(ctxUpdate)
    } else {
      unsentSabrContexts.push(ctxUpdate.type)
    }
  }

  return { sabrContexts, unsentSabrContexts }
}

/**
 * @template T
 * @param {import('googlevideo/ump').CompositeBuffer} data
 * @param {{ decode: (data: Uint8Array) => T }} decoder
 * @returns {T | undefined}
 */
function decodePart(data, decoder) {
  if (!data.chunks.length) return undefined

  try {
    const chunk = data.chunks.length === 1 ? data.chunks[0] : concatenateChunks(data.chunks)
    return decoder.decode(chunk)
  } catch {
    return undefined
  }
}

const MAX_SABR_REDIRECTS_PER_REQUEST = 5

// Instrumentation baselines (maintainer's dev-build console logs, 2026-11-17) show a
// healthy SABR stream running long "slow start" pacing cycles early in a video: one op
// legitimately polls ~11 times over ~16 s (mix of ~2 s readahead backoffs and
// immediate-retry waits) before its segment arrives. Reloading below that just loses a
// race the server was already winning, so the watchdog is purely time-based: an op that
// has waited MAX_LEGIT_CUMULATIVE_BACKOFF_MS without completing is ordered a (view-level
// governed) fake reload. Request *count* stays bounded by the NRP retry cap (>= 100 per
// op) and request *rate* by the backoff floor below.
const MIN_SABR_BACKOFF_MS = 250
const MAX_LEGIT_CUMULATIVE_BACKOFF_MS = 30000

/**
 * Jittered floor wait for SABR backoff requests below MIN_SABR_BACKOFF_MS (including the
 * 0/absent "issue the next request immediately" case). Spreads otherwise synchronized
 * bursts and degrades them gracefully. Without this, backoffTimeMs values of 0-small
 * integers produce bursts of identical POSTs at network speed.
 * @returns {number} 250-1000 ms
 */
function getFlooredBackoffDelayMs() {
  return 250 + Math.floor(Math.random() * 751)
}

/**
 * Checks whether a `SABR_REDIRECT` target is the endpoint the stream is already using,
 * modulo the `rn` request counter this client sets itself. Honoring such a redirect
 * means recursing on the identical request.
 * @param {string} redirectUrlString
 * @param {string} currentUrlString
 * @returns {boolean}
 */
function isSelfSabrRedirect(redirectUrlString, currentUrlString) {
  try {
    const redirectUrl = new URL(redirectUrlString)
    const currentUrl = new URL(currentUrlString)
    redirectUrl.searchParams.delete('rn')
    currentUrl.searchParams.delete('rn')
    return redirectUrl.href === currentUrl.href
  } catch {
    return false
  }
}

/**
 * @param {(args: void) => void} callback
 * @param {number} timeoutMs
 * @return TimeoutController
 */
function createTimeoutController(callback, timeoutMs) {
  return {
    _timeout: setTimeout(callback, timeoutMs),
    _resetCount: 0,
    resetTimeoutOnce() {
      if (this._resetCount > 0) return

      this.clearTimeout()
      this._timeout = setTimeout(callback, timeoutMs)
      this._resetCount++
    },
    clearTimeout() {
      clearTimeout(this._timeout)
    },
  }
}

/**
 * @param {OperationInputs} operationInputs - readonly
 * @param {CurrentState} currentState - can be updated
 */
async function doRequest(
  operationInputs,
  currentState,
) {
  let response
  /** @type {Uint8Array[]} */
  const responseDataChunks = []
  let segmentComplete = false
  let shouldRetry = false
  let shouldRetryDueToNextRequestPolicy = false

  let invalidPoToken = false
  let error

  if (currentState.sabrStreamState.playerReloadRequested) {
    // Multiple requests might be issued at the same time, other requests should abort themselves once reload requested
    throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
  }

  try {
    let shouldReloadDueToBackoffLoop = false
    const nextRequestPolicy = currentState.sabrStreamState.nextRequestPolicy
    if (nextRequestPolicy) {
      // The `backoffTimeMs` proto field is optional; a 0/absent value means "issue the
      // next request immediately", and small positive values rate-limit the stream
      // barely at all. Both are floored to the jittered MIN_SABR_BACKOFF_MS floor so
      // retry bursts cannot run at network speed. Only genuine backoffs at or above
      // the floor count as "backoff requested" (used for the progress-toast event), so
      // that a legitimate zero-backoff policy can never turn a request burst into a
      // reload burst.
      const rawBackoffTimeMs = nextRequestPolicy.backoffTimeMs || 0
      const currentBackoffTimeMs = rawBackoffTimeMs >= MIN_SABR_BACKOFF_MS
        ? rawBackoffTimeMs
        : getFlooredBackoffDelayMs()

      if (rawBackoffTimeMs >= MIN_SABR_BACKOFF_MS) {
        currentState.eventEmitter.emit('backoff-requested', { backoffMs: rawBackoffTimeMs })
      } else if (SABR_DIAGNOSTICS) {
        currentState.flooredBackoffWaitCount += 1
      }

      // Wait but can be aborted
      await new Promise((resolve, reject) => {
        setTimeout(resolve, currentBackoffTimeMs)
        currentState.abortController.signal.addEventListener('abort', reject)
      })
      // Must reset AFTER waiting to avoid requested aborted
      // Since long backoff time mostly happens on the start of video playback we only reset timeout once
      // i.e. backoff time parts received will not reset timeout - counted as video loading issue
      currentState.timeoutController?.resetTimeoutOnce()

      currentState.cumulativeBackOffTimeMs += currentBackoffTimeMs
      if (rawBackoffTimeMs > 0) {
        currentState.cumulativeBackOffRequested += 1
      }

      // Time-based only on purpose (see MAX_LEGIT_CUMULATIVE_BACKOFF_MS). The op-wide
      // timeout is kept as an arm so user-configured shorter timeouts still recover.
      const timeoutMs = operationInputs.request.retryParameters.timeout
      if (
        currentState.cumulativeBackOffTimeMs >= MAX_LEGIT_CUMULATIVE_BACKOFF_MS ||
        (timeoutMs > 0 && timeoutMs <= (currentState.cumulativeBackOffTimeMs + currentBackoffTimeMs))
      ) {
        shouldReloadDueToBackoffLoop = true
      }
    }
    if (shouldReloadDueToBackoffLoop || currentState.cumulativeRetryDueToNextRequestPolicy >= 100) {
      // Fire fake reload event due to detecting retry loop
      if (SABR_DIAGNOSTICS) {
        logSabrDiagnosticBreakout(
          shouldReloadDueToBackoffLoop ? 'backoff watchdog' : 'NRP retry cap',
          currentState
        )
      }
      currentState.sabrStreamState.playerReloadRequested = true
      if (!currentState.abortController.signal.aborted) {
        currentState.abortController.abort()
        currentState.eventEmitter.emit('reload')
      }
    }

    const { itag, lastModified, xtags } = formatIdFromString(operationInputs.formatIdString)
    let mediaHeaderId

    const umpReader = new UmpReader({
      onPart: (type, data) => {
        switch (type) {
          case UMPPartId.STREAM_PROTECTION_STATUS: {
            const streamProtectionStatus = decodePart(data, StreamProtectionStatus)
            if (!streamProtectionStatus) break

            if (streamProtectionStatus.status === 3) {
              invalidPoToken = true
            }
            break
          }
          case UMPPartId.SABR_ERROR: {
            const sabrError = decodePart(data, SabrError)
            if (!sabrError) break

            error = `SABR Error: type: ${sabrError.type}, code: ${sabrError.code}`
            break
          }
          case UMPPartId.SABR_REDIRECT: {
            const sabrRedirect = decodePart(data, SabrRedirect)
            if (!sabrRedirect?.url) break

            currentState.cumulativeRedirects += 1

            // A redirect chain that points back at the current endpoint or ping-pongs
            // between endpoints would otherwise recurse without any bound: the retry
            // counter only covers NextRequestPolicy retries (see the
            // `shouldRetryDueToNextRequestPolicy` check below). Convert such loops
            // into the same breakout the backoff watchdog uses.
            const isSelfRedirect = isSelfSabrRedirect(sabrRedirect.url, currentState.sabrStreamState.sabrUrl)

            if (isSelfRedirect || currentState.cumulativeRedirects > MAX_SABR_REDIRECTS_PER_REQUEST) {
              if (SABR_DIAGNOSTICS) {
                logSabrDiagnosticBreakout(
                  isSelfRedirect ? 'self redirect' : 'redirect cap',
                  currentState
                )
              }

              currentState.sabrStreamState.playerReloadRequested = true
              if (!currentState.abortController.signal.aborted) {
                currentState.abortController.abort()
                currentState.eventEmitter.emit('reload')
              }
              break
            }

            currentState.sabrStreamState.sabrUrl = sabrRedirect.url
            shouldRetry = true
            break
          }
          case UMPPartId.MEDIA_HEADER: {
            if (mediaHeaderId === undefined) {
              const mediaHeader = decodePart(data, MediaHeader)
              if (!mediaHeader) break

              if (
                mediaHeader.formatId.itag === itag &&
                mediaHeader.formatId.lastModified === lastModified &&
                mediaHeader.formatId.xtags === xtags
              ) {
                if (operationInputs.isInit && mediaHeader.isInitializationSegment) {
                  mediaHeaderId = mediaHeader.headerId
                } else if (!operationInputs.isInit && mediaHeader.segmentNum === operationInputs.sequenceNumber) {
                  mediaHeaderId = mediaHeader.headerId
                }
              }
            }

            break
          }
          case UMPPartId.MEDIA: {
            if (mediaHeaderId === data.getUint8(0)) {
              const chunks = data.split(1).remainingBuffer.chunks
              if (SABR_DIAGNOSTICS) {
                for (const chunk of chunks) {
                  currentState.receivedMediaBytes += chunk.byteLength
                }
              }
              responseDataChunks.push(...chunks)
            }
            break
          }
          case UMPPartId.MEDIA_END: {
            if (mediaHeaderId === data.getUint8(0)) {
              segmentComplete = true
              currentState.abortStatus.finished = true
              currentState.abortController.abort()
            }
            break
          }
          case UMPPartId.NEXT_REQUEST_POLICY: {
            const nextRequestPolicy = decodePart(data, NextRequestPolicy)

            shouldRetry = true
            shouldRetryDueToNextRequestPolicy = true

            currentState.sabrStreamState.nextRequestPolicy = nextRequestPolicy
            currentState.abrRequest.streamerContext.playbackCookie = nextRequestPolicy?.playbackCookie

            currentState.abrRequest.streamerContext.backoffTimeMs = nextRequestPolicy?.backoffTimeMs
            break
          }
          case UMPPartId.FORMAT_INITIALIZATION_METADATA: {
            break
          }
          case UMPPartId.SABR_CONTEXT_UPDATE: {
            const sabrContextUpdate = decodePart(data, SabrContextUpdate)
            if (!sabrContextUpdate) break

            if (sabrContextUpdate.type !== undefined && sabrContextUpdate.value?.length) {
              if (
                sabrContextUpdate.writePolicy === SabrContextWritePolicy.KEEP_EXISTING &&
                currentState.sabrStreamState.sabrContexts.has(sabrContextUpdate.type)
              ) {
                break
              }

              currentState.sabrStreamState.sabrContexts.set(sabrContextUpdate.type, sabrContextUpdate)

              if (sabrContextUpdate.sendByDefault) {
                currentState.sabrStreamState.activeSabrContextTypes.add(sabrContextUpdate.type)
              }
            }
            break
          }
          case UMPPartId.SABR_CONTEXT_SENDING_POLICY: {
            const sabrContextSendingPolicy = decodePart(data, SabrContextSendingPolicy)
            if (!sabrContextSendingPolicy) break

            for (const startPolicy of sabrContextSendingPolicy.startPolicy) {
              if (!currentState.sabrStreamState.activeSabrContextTypes.has(startPolicy)) {
                currentState.sabrStreamState.activeSabrContextTypes.add(startPolicy)
              }
            }

            for (const stopPolicy of sabrContextSendingPolicy.stopPolicy) {
              if (currentState.sabrStreamState.activeSabrContextTypes.has(stopPolicy)) {
                currentState.sabrStreamState.activeSabrContextTypes.delete(stopPolicy)
              }
            }

            for (const discardPolicy of sabrContextSendingPolicy.discardPolicy) {
              if (currentState.sabrStreamState.sabrContexts.has(discardPolicy)) {
                currentState.sabrStreamState.sabrContexts.delete(discardPolicy)
              }
            }
            break
          }
          case UMPPartId.RELOAD_PLAYER_RESPONSE: {
            const reloadPlaybackContext = decodePart(data, ReloadPlaybackContext)
            if (!reloadPlaybackContext) break

            // Whole video cannot be played
            if (SABR_DIAGNOSTICS) {
              logSabrDiagnosticBreakout('server-ordered reload (RELOAD_PLAYER_RESPONSE)', currentState)
            }
            currentState.sabrStreamState.playerReloadRequested = true
            if (!currentState.abortController.signal.aborted) {
              currentState.abortController.abort()
              currentState.eventEmitter.emit('reload')
            }
            break
          }
          default: {
            break
          }
        }
      }
    })

    const sabrURL = new URL(currentState.sabrStreamState.sabrUrl)
    sabrURL.searchParams.set('rn', String(currentState.sabrStreamState.requestNumber++))
    if (SABR_DIAGNOSTICS) {
      recordSabrDiagnosticPost()
    }
    response = await fetch(sabrURL.toString(), currentState.requestInit)

    operationInputs.headersReceived({})

    const reader = response.body.getReader()
    let readObj = await reader.read()

    while (!readObj.done && !currentState.abortStatus.finished) {
      await umpReader.feed(readObj.value)

      if (!currentState.abortStatus.finished) {
        readObj = await reader.read()
      }
    }
  } catch (error) {
    if (currentState.abortStatus.cancelled) {
      throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
    } else if (currentState.abortStatus.timedOut) {
      throw createRecoverableNetworkError(ShakaError.Code.TIMEOUT, operationInputs.uri, operationInputs.requestType)
    } else if (!currentState.abortStatus.finished) {
      throw createRecoverableNetworkError(ShakaError.Code.HTTP_ERROR, operationInputs.uri, error, operationInputs.requestType)
    }
  }

  if (currentState.abortStatus.cancelled) {
    throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
  } else if (currentState.abortStatus.timedOut) {
    throw createRecoverableNetworkError(ShakaError.Code.TIMEOUT, operationInputs.uri, operationInputs.requestType)
  }

  if (responseDataChunks.length > 0 && segmentComplete) {
    const data = /** @__NOINLINE__ */ concatenateChunks(responseDataChunks)

    if (operationInputs.isInit) {
      currentState.initDataCache.set(operationInputs.formatIdString, data)
    }

    /** @type {shaka.extern.Response} */
    return {
      uri: operationInputs.uri,
      originalUri: operationInputs.uri,
      data,
      status: response.status,
      headers: {},
      fromCache: false,
      originalRequest: operationInputs.request,
    }
  } else if (shouldRetry) {
    if (shouldRetryDueToNextRequestPolicy) {
      // Only count on actual retry to avoid counting false positive (when segmentComplete
      currentState.cumulativeRetryDueToNextRequestPolicy += 1
    }

    const { sabrContexts, unsentSabrContexts } = prepareSabrContexts(currentState.sabrStreamState)

    currentState.abrRequest.streamerContext.sabrContexts = sabrContexts
    currentState.abrRequest.streamerContext.unsentSabrContexts = unsentSabrContexts

    let body

    try {
      body = VideoPlaybackAbrRequest.encode(currentState.abrRequest).finish()
    } catch (error) {
      console.error('Invalid VideoPlaybackAbrRequest data', currentState.abrRequest)
      throw error
    }

    currentState.requestInit = {
      body,
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf',
        'accept-encoding': 'identity',
        accept: 'application/vnd.yt-ump',
      },
      signal: currentState.abortController.signal,
    }
    currentState.abortStatus.timedOut = false

    currentState.abortStatus.finished = false
    return doRequest(operationInputs, currentState)
  } else if (invalidPoToken) {
    throw new ShakaError(
      ShakaError.Severity.CRITICAL,
      ShakaError.Category.NETWORK,
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error('Invalid PO token'),
      operationInputs.requestType,
    )
  } else if (error) {
    throw createRecoverableNetworkError(
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error(error),
      operationInputs.requestType,
    )
  } else if (responseDataChunks.length > 0 && !segmentComplete) {
    throw createRecoverableNetworkError(
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error('Incomplete segment, missing MEDIA_END part'),
      operationInputs.requestType,
    )
  } else if (response.status === 200) {
    throw createRecoverableNetworkError(
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error('Empty response, this should not happen'),
      operationInputs.requestType,
    )
  } else {
    const severity = response.status === 401 || response.status === 403
      ? ShakaError.Severity.CRITICAL
      : ShakaError.Severity.RECOVERABLE

    throw new ShakaError(
      severity,
      ShakaError.Category.NETWORK,
      ShakaError.Code.BAD_HTTP_STATUS,
      operationInputs.uri,
      response.status,
      '',
      {},
      operationInputs.requestType,
      operationInputs.uri,
    )
  }
}

/**
 * @param {import('../../views/Watch/Watch').SabrData} sabrData
 * @param {() => shaka.Player} getPlayer
 * @param {() => shaka.extern.Manifest} getManifest
 * @param {import('vue').ComputedRef<number>} playerWidth
 * @param {import('vue').ComputedRef<number>} playerHeight
 * @return SabrStream
 */
export function setupSabrScheme(sabrData, getPlayer, getManifest, playerWidth, playerHeight) {
  const eventEmitter = new EventEmitterLike()

  /**
   * Caches the init data until the video ends
   * that way changing qualities and between audio and DASH
   * doesn't have to fetch the init data and segment index again
   * @type {Map<string, Uint8Array>}
   */
  const initDataCache = new Map()

  const poToken = base64ToU8(sabrData.poToken)
  const videoPlaybackUstreamerConfig = base64ToU8(sabrData.ustreamerConfig)
  const clientInfo = deepCopy(sabrData.clientInfo)

  /** @type {SabrStreamState} */
  const sabrStreamState = {
    sabrUrl: sabrData.url,
    activeSabrContextTypes: new Set(),
    sabrContexts: new Map(),
    nextRequestPolicy: undefined,
    playerReloadRequested: false,
    requestNumber: 0,
  }

  shaka.net.NetworkingEngine.registerScheme('sabr', (uri, request, requestType, _progressUpdated, headersReceived, _config) => {
    // lazily fetch it as the variable is only set after setupSabrScheme is called
    // but it will definitely exist when we receive a request here.
    const player = getPlayer()
    if (player == null) {
      // This is true during reload, returning a promise to suppress error
      return new AbortableOperation(Promise.resolve())
    }
    const isAudioOnly = player.isAudioOnly()

    const url = new URL(request.uris[0])

    const isInit = url.searchParams.has('init')
    const formatIdString = url.searchParams.get('formatId')

    if (isInit && initDataCache.has(formatIdString)) {
      return /** @__NOINLINE__ */ createCacheResponse(uri, request, initDataCache.get(formatIdString))
    }

    const variantTracks = player.getVariantTracks()
    const activeVariant = variantTracks.find(track => track.active)

    const streamIsAudio = url.pathname === 'audio'
    const streamIsVideo = url.pathname === 'video'

    let audioFormatId
    let videoFormatId

    if (streamIsAudio) {
      audioFormatId = formatIdFromString(formatIdString)

      if (isAudioOnly) {
        // We need to specify a video format even for audio only otherwise we get an error response
        videoFormatId = formatIdFromString(url.searchParams.get('videoFormatId'))
      } else {
        videoFormatId = formatIdFromString((activeVariant ?? variantTracks[0]).originalVideoId)
      }
    } else if (streamIsVideo) {
      videoFormatId = formatIdFromString(formatIdString)

      // for the first fetching of the initial data there won't be an active variant
      // (shaka-player only sets it to active after it has fetched the init/segment data)
      if (activeVariant) {
        audioFormatId = formatIdFromString(activeVariant.originalAudioId)
      } else {
        const candidates = variantTracks.filter((track) => track.audioRoles.includes('main'))

        const probableAudioFormat = candidates.reduce((previous, current) => {
          return current.audioBandwidth >= previous.audioBandwidth ? current : previous
        }, candidates[0])

        audioFormatId = formatIdFromString(probableAudioFormat.originalAudioId)
      }
    }

    /** @type {import('googlevideo/protos').BufferedRange[]} */
    const bufferedRanges = []

    if (!isInit && activeVariant) {
      /** @__NOINLINE__ */ fillBufferedRanges(player, getManifest(), isAudioOnly, streamIsVideo, streamIsAudio, bufferedRanges, activeVariant)
    }

    let playerTimeMs = '0'

    if (url.searchParams.has('startTimeMs')) {
      playerTimeMs = url.searchParams.get('startTimeMs')
    }

    const drcEnabled = url.searchParams.has('drc') || !!(activeVariant && activeVariant.audioRoles.includes('drc'))
    const enableVoiceBoost = url.searchParams.has('vb') || !!(activeVariant && activeVariant.audioRoles.includes('vb'))

    const resolution = streamIsVideo ? parseInt(url.searchParams.get('resolution')) : undefined

    const { sabrContexts, unsentSabrContexts } = prepareSabrContexts(sabrStreamState)

    /** @type {VideoPlaybackAbrRequest} */
    const requestData = {
      clientAbrState: {
        bandwidthEstimate: String(Math.round(player.getStats().estimatedBandwidth)),
        timeSinceLastManualFormatSelectionMs: streamIsVideo ? '0' : undefined,
        stickyResolution: resolution,
        lastManualSelectedResolution: resolution,
        playbackRate: player.getPlaybackRate(),
        enabledTrackTypesBitfield: streamIsAudio ? 1 : 0,
        drcEnabled,
        enableVoiceBoost,
        playerTimeMs,
        clientViewportWidth: playerWidth.value,
        clientViewportHeight: playerHeight.value,
        clientViewportIsFlexible: false
      },
      selectedAudioFormatIds: [audioFormatId],
      selectedVideoFormatIds: [videoFormatId],
      selectedCaptionFormatIds: [],
      initializationFormatIds: isInit ? [] : [audioFormatId, videoFormatId],
      bufferedRanges,
      streamerContext: {
        poToken,
        clientInfo,
        sabrContexts,
        unsentSabrContexts,
        playbackCookie: sabrStreamState.nextRequestPolicy?.playbackCookie,
      },
      ssapPlaybackInfos: [],
      field1000: [],
      videoPlaybackUstreamerConfig,
    }

    let body

    try {
      body = VideoPlaybackAbrRequest.encode(requestData).finish()
    } catch (error) {
      console.error('Invalid VideoPlaybackAbrRequest data', requestData)
      throw error
    }

    const sequenceNumber = parseInt(url.searchParams.get('sq'))

    /**
     * Stores whatever state that should be updated across the whole "session"
     * @type {OperationInputs}
     */
    const opInputs = {
      uri,
      request,
      requestType,
      headersReceived,

      formatIdString,
      isInit,
      sequenceNumber,
    }

    const abortController = new AbortController()

    /** @type {RequestInit} */
    const init = {
      body,
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf',
        'accept-encoding': 'identity',
        accept: 'application/vnd.yt-ump',
      },
      signal: abortController.signal,
    }

    /**
     * Stores whatever state that should be updated across the whole "session"
     * @type {AbortStatus}
     */
    const abortStatus = {
      cancelled: false,
      timedOut: false,
      finished: false,
    }

    const timeoutMs = request.retryParameters.timeout
    let timeoutController = null
    if (timeoutMs) {
      timeoutController = createTimeoutController(() => {
        abortStatus.timedOut = true
        abortController.abort()
      }, timeoutMs)
    }

    /**
     * Stores whatever state that should be updated across the whole "session"
     * @type {CurrentState}
     */
    const currentState = {
      initDataCache,
      abrRequest: requestData,
      requestInit: init,
      abortStatus: abortStatus,
      abortController,
      sabrStreamState,
      timeoutController,
      eventEmitter,
      cumulativeBackOffTimeMs: 0,
      cumulativeBackOffRequested: 0,
      cumulativeRetryDueToNextRequestPolicy: 0,
      cumulativeRedirects: 0,
      flooredBackoffWaitCount: 0,
      receivedMediaBytes: 0,
    }

    const pendingRequest = doRequest(opInputs, currentState)

    const op = new AbortableOperation(pendingRequest, () => {
      abortStatus.cancelled = true
      abortController.abort()
      return Promise.resolve()
    })

    if (timeoutController) {
      op.finally(() => {
        timeoutController.clearTimeout()
      })
    }

    return op
  })

  const cleanup = () => {
    shaka.net.NetworkingEngine.unregisterScheme('sabr')
    initDataCache.clear()
  }

  return {
    onBackoffRequested(callback) {
      eventEmitter.on('backoff-requested', callback)
    },
    onReloadOnce(callback) {
      eventEmitter.once('reload', callback)
    },
    cleanup,
  }
}
