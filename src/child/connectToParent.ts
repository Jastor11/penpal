import createDestructor from '../createDestructor';
import createLogger from '../createLogger';
import {
  SynMessage,
  Methods,
  PenpalError, CallSender
} from '../types';
import { ErrorCode, MessageType, NativeEventType } from '../enums';
import validateWindowIsIframe from './validateWindowIsIframe';
import handleSynAckMessageFactory from './handleSynAckMessageFactory';
import startConnectionTimeout from '../startConnectionTimeout';

const areGlobalsAccessible = () => {
  try {
    clearTimeout();
  } catch (e) {
    return false;
  }
  return true;
}

type Options = {
  /**
   * Valid parent origin used to restrict communication.
   */
  parentOrigin?: string;
  /**
   * Methods that may be called by the parent window.
   */
  methods?: Methods;
  /**
   * The amount of time, in milliseconds, Penpal should wait
   * for the parent to respond before rejecting the connection promise.
   */
  timeout?: number;
  /**
   * Whether log messages should be emitted to the console.
   */
  debug?: boolean;
};

type Connection = {
  /**
   * A promise which will be resolved once a connection has been established.
   */
  promise: Promise<CallSender>;
  /**
   * A method that, when called, will disconnect any messaging channels.
   * You may call this even before a connection has been established.
   */
  destroy: Function;
};

/**
 * Attempts to establish communication with the parent window.
 */
export default (options: Options = {}): Connection => {
  const { parentOrigin = '*', methods = {}, timeout, debug = false } = options;
  const log = createLogger(debug);
  const destructor = createDestructor();
  const { destroy, onDestroy } = destructor;

  validateWindowIsIframe();

  const handleSynAckMessage = handleSynAckMessageFactory(
    parentOrigin,
    methods,
    destructor,
    log
  );

  const sendSynMessage = () => {
    log('Child: Handshake - Sending SYN');
    const synMessage: SynMessage = {
      penpal: MessageType.Syn
    };
    window.parent.postMessage(synMessage, parentOrigin);
  }

  const promise: Promise<CallSender> = new Promise((resolve, reject) => {
    const stopConnectionTimeout = startConnectionTimeout(timeout, destroy);
    const handleMessage = (event: MessageEvent) => {
      // Under niche scenarios, we get into this function after
      // the iframe has been removed from the DOM. In Edge, this
      // results in "Object expected" errors being thrown when we
      // try to access properties on window (global properties).
      // For this reason, we try to access a global up front (clearTimeout)
      // and if it fails we can assume the iframe has been removed
      // and we ignore the message event.
      if (!areGlobalsAccessible()) {
        return;
      }

      if (event.source !== parent || !event.data) {
        return;
      }

      if (event.data.penpal === MessageType.SynAck) {
        const callSender = handleSynAckMessage(event);
        if (callSender) {
          window.removeEventListener(NativeEventType.Message, handleMessage);
          stopConnectionTimeout();
          resolve(callSender);
        }
      }
    };

    window.addEventListener(NativeEventType.Message, handleMessage);

    sendSynMessage();

    onDestroy((error?: PenpalError) => {
      window.removeEventListener(NativeEventType.Message, handleMessage);
      if (!error) {
        error = new Error(
          'Connection destroyed'
        ) as PenpalError;
        error.code = ErrorCode.ConnectionDestroyed;
      }
      reject(error);
    });
  });

  return {
    promise,
    destroy() {
      // Don't allow consumer to pass an error into destroy.
      destroy();
    }
  };
};
