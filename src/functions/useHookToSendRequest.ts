import Hook, { SaveStateFn } from '@/Hook';
import Method from '@/Method';
import defaultErrorLogger from '@/predefine/defaultErrorLogger';
import defaultMiddleware from '@/predefine/defaultMiddleware';
import { filterSnapshotMethods } from '@/storage/methodSnapShots';
import { getResponseCache, setResponseCache } from '@/storage/responseCache';
import { getPersistentResponse } from '@/storage/responseStorage';
import { getStateCache, removeStateCache, setStateCache } from '@/storage/stateCache';
import createAlovaEvent from '@/utils/createAlovaEvent';
import {
  exportFetchStates,
  GeneralFn,
  getConfig,
  getContext,
  getHandlerMethod,
  getLocalCacheConfigParam,
  instanceOf,
  isFn,
  key,
  noop,
  sloughConfig,
  sloughFunction
} from '@/utils/helper';
import myAssert, { assertMethodMatcher } from '@/utils/myAssert';
import {
  falseValue,
  forEach,
  HOOK_WATCHER,
  len,
  MEMORY,
  promiseCatch,
  PromiseCls,
  promiseReject,
  promiseResolve,
  promiseThen,
  pushItem,
  STORAGE_PLACEHOLDER,
  STORAGE_RESTORE,
  trueValue,
  undefinedValue
} from '@/utils/variables';
import {
  AlovaCompleteEvent,
  AlovaErrorEvent,
  AlovaEvent,
  AlovaFetcherMiddleware,
  AlovaFrontMiddleware,
  AlovaGuardNext,
  AlovaMethodHandler,
  AlovaSuccessEvent,
  CompleteHandler,
  ErrorHandler,
  FetcherHookConfig,
  FrontRequestHookConfig,
  FrontRequestState,
  SuccessHandler,
  UseHookConfig,
  WatcherHookConfig
} from '~/typings';
import sendRequest from './sendRequest';

/**
 * 统一处理useRequest/useWatcher/useController等请求钩子函数的请求逻辑
 * @param methodHandler 请求方法对象或获取函数
 * @param frontStates 前端状态集合
 * @param useHookConfig useHook配置对象
 * @param successHandlers 成功回调
 * @param errorHandlers 失败回调
 * @param completeHandlers 完成回调
 * @param sendCallingArgs send函数参数
 * @param isFetcher 是否更新缓存状态，一般在useFetcher时设置为true
 * @returns 请求状态
 */
export default function useHookToSendRequest<S, E, R, T, RC, RE, RH, UC extends UseHookConfig>(
  hookInstance: Hook<S, E, R, T, RC, RE, RH>,
  methodHandler: Method<S, E, R, T, RC, RE, RH> | AlovaMethodHandler<S, E, R, T, RC, RE, RH>,
  useHookConfig: UC,
  sendCallingArgs: any[] = [],
  isFetcher = falseValue
) {
  const { fs: frontStates, sh: successHandlers, eh: errorHandlers, ch: completeHandlers, ht } = hookInstance,
    methodInstance = getHandlerMethod(methodHandler, sendCallingArgs),
    { force: forceRequest = falseValue, middleware = defaultMiddleware } = useHookConfig as
      | FrontRequestHookConfig<S, E, R, T, RC, RE, RH>
      | FetcherHookConfig,
    { id, options, storage } = getContext(methodInstance),
    {
      statesHook: { update },
      errorLogger
    } = options,
    // 如果是静默请求，则请求后直接调用onSuccess，不触发onError，然后也不会更新progress
    methodKey = key(methodInstance),
    { e: expireMilliseconds, m: cacheMode, t: tag } = getLocalCacheConfigParam(methodInstance),
    { sendable = () => trueValue, abortLast = trueValue } = useHookConfig as WatcherHookConfig<S, E, R, T, RC, RE, RH>;
  hookInstance.m = methodInstance;

  let _sendable: boolean;
  try {
    _sendable = !!sendable(createAlovaEvent(3, methodInstance, sendCallingArgs));
  } catch (error) {
    _sendable = falseValue;
  }

  if (!_sendable) {
    update({ loading: falseValue }, frontStates);
    return promiseResolve(undefinedValue);
  }

  // 初始化状态数据，在拉取数据时不需要加载，因为拉取数据不需要返回data数据
  let removeStates = noop,
    saveStates = noop as SaveStateFn,
    cachedResponse: R | undefined = getResponseCache(id, methodKey),
    isNextCalled = falseValue,
    responseHandlePromise = promiseResolve<any>(undefinedValue),
    fromCache = () => !!cachedResponse,
    // 是否为受控的loading状态，当为true时，响应处理中将不再设置loading为false
    controlledLoading = falseValue;
  if (!isFetcher) {
    // 当缓存模式为memory时不获取缓存，减少缓存获取
    const persistentResponse =
      cacheMode !== MEMORY ? getPersistentResponse(id, methodKey, storage, tag) : undefinedValue;

    // 如果有持久化数据，则需要判断是否需要恢复它到缓存中
    // 如果是STORAGE_RESTORE模式，且缓存没有数据时，则需要将持久化数据恢复到缓存中
    if (cacheMode === STORAGE_RESTORE && !cachedResponse && persistentResponse) {
      setResponseCache(id, methodKey, persistentResponse, expireMilliseconds);
      cachedResponse = persistentResponse;
    }

    // 当缓存模式为placeholder时，先更新data再去发送请求
    if (cacheMode === STORAGE_PLACEHOLDER && persistentResponse) {
      update(
        {
          data: persistentResponse
        },
        frontStates
      );
    }

    // 将初始状态存入缓存以便后续更新
    saveStates = (frontStates: FrontRequestState) => setStateCache(id, methodKey, frontStates);
    saveStates(frontStates);

    // 设置状态移除函数，将会传递给hook内的effectRequest，它将被设置在组件卸载时调用
    removeStates = () => removeStateCache(id, methodKey);
  }

  // 中间件函数next回调函数，允许修改强制请求参数，甚至替换即将发送请求的Method实例
  const guardNext: AlovaGuardNext<S, E, R, T, RC, RE, RH> = guardNextConfig => {
    isNextCalled = trueValue;
    const { force: guardNextForceRequest = forceRequest, method: guardNextReplacingMethod = methodInstance } =
        guardNextConfig || {},
      forceRequestFinally = sloughConfig(guardNextForceRequest, sendCallingArgs),
      requestCtrl = sendRequest(guardNextReplacingMethod, forceRequestFinally),
      { response, onDownload = noop, onUpload = noop, fromCache: getFromCacheValue, abort } = requestCtrl,
      progressUpdater = (stage: 'downloading' | 'uploading') => (loaded: number, total: number) => {
        update(
          {
            [stage]: {
              loaded,
              total
            }
          },
          frontStates
        );
      };

    // 每次发送请求都需要保存最新的控制器
    pushItem(hookInstance.sf, saveStates);
    pushItem(hookInstance.rf, removeStates);
    hookInstance.ar = abort;
    fromCache = getFromCacheValue;

    // loading状态受控时将不更改loading
    // 命中缓存，或强制请求时需要设置loading为true
    !controlledLoading && update({ loading: !!forceRequestFinally || !cachedResponse }, frontStates);

    responseHandlePromise = response();
    const { enableDownload, enableUpload } = getConfig(methodInstance);
    enableDownload && onDownload(progressUpdater('downloading'));
    enableUpload && onUpload(progressUpdater('uploading'));
    return responseHandlePromise;
  };

  // 调用中间件函数
  let successHandlerDecorator: (
    handler: SuccessHandler<S, E, R, T, RC, RE, RH>,
    event: AlovaSuccessEvent<S, E, R, T, RC, RE, RH>,
    index: number,
    length: number
  ) => void | void;
  let errorHandlerDecorator: (
    handler: ErrorHandler<S, E, R, T, RC, RE, RH>,
    event: AlovaErrorEvent<S, E, R, T, RC, RE, RH>,
    index: number,
    length: number
  ) => void | void;
  let completeHandlerDecorator: (
    handler: CompleteHandler<S, E, R, T, RC, RE, RH>,
    event: AlovaCompleteEvent<S, E, R, T, RC, RE, RH>,
    index: number,
    length: number
  ) => void | void;

  const commonContext = {
    method: methodInstance,
    cachedResponse,
    config: useHookConfig,
    abort: () => hookInstance.ar(),
    decorateSuccess(decorator: NonNullable<typeof successHandlerDecorator>) {
      isFn(decorator) && (successHandlerDecorator = decorator);
    },
    decorateError(decorator: NonNullable<typeof errorHandlerDecorator>) {
      isFn(decorator) && (errorHandlerDecorator = decorator);
    },
    decorateComplete(decorator: NonNullable<typeof completeHandlerDecorator>) {
      isFn(decorator) && (completeHandlerDecorator = decorator);
    }
  };

  const fetchStates = exportFetchStates(frontStates);
  // 调用中间件函数
  const middlewareCompletePromise: Promise<any> = isFetcher
    ? (middleware as AlovaFetcherMiddleware<S, E, R, T, RC, RE, RH>)(
        {
          ...commonContext,
          fetchArgs: sendCallingArgs,
          fetch: (matcher, ...args) => {
            const methodInstance = filterSnapshotMethods(matcher, falseValue);
            assertMethodMatcher(methodInstance);
            return useHookToSendRequest(hookInstance, methodInstance as Method, useHookConfig, args, trueValue);
          },
          fetchStates,
          update: newFetchStates => update(newFetchStates, fetchStates),
          controlFetching(control = trueValue) {
            controlledLoading = control;
          }
        },
        guardNext
      )
    : (middleware as AlovaFrontMiddleware<S, E, R, T, RC, RE, RH>)(
        {
          ...commonContext,
          sendArgs: sendCallingArgs,
          send: (...args) => useHookToSendRequest(hookInstance, methodHandler, useHookConfig, args),
          frontStates,
          update: newFrontStates => update(newFrontStates, frontStates),
          controlLoading(control = trueValue) {
            controlledLoading = control;
          }
        },
        guardNext
      );

  myAssert(instanceOf(middlewareCompletePromise, PromiseCls), 'middleware must be a async function');
  const runArgsHandler = (
    handlers: GeneralFn[],
    decorator: (...args: any[]) => void,
    event: AlovaEvent<S, E, R, T, RC, RE, RH>
  ) => {
    forEach(handlers, (handler, index) =>
      isFn(decorator) ? decorator(handler, event, index, len(handlers)) : handler(event)
    );
  };

  const // 是否需要更新响应数据，以及调用响应回调
    toUpdateResponse = () => ht !== HOOK_WATCHER || !abortLast || hookInstance.m === methodInstance,
    // 统一处理响应
    responseCompletePromise = promiseCatch(
      promiseThen(middlewareCompletePromise, middlewareReturnedData => {
        const afterSuccess = (data: any) => {
          // 更新缓存响应数据
          if (!isFetcher) {
            toUpdateResponse() && update({ data }, frontStates);
          } else {
            // 更新缓存内的状态，一般为useFetcher中进入
            const cachedState = getStateCache(id, methodKey);
            cachedState && update({ data }, cachedState);
          }

          // 如果需要更新响应数据，则在请求后触发对应回调函数
          if (toUpdateResponse()) {
            const newStates = { error: undefinedValue } as Partial<FrontRequestState<any, any, any, any, any>>;
            // loading状态受控时将不再更改为false
            !controlledLoading && (newStates.loading = falseValue);
            update(newStates, frontStates);
            runArgsHandler(
              successHandlers,
              successHandlerDecorator,
              createAlovaEvent(0, methodInstance, sendCallingArgs, fromCache(), data)
            );
            runArgsHandler(
              completeHandlers,
              completeHandlerDecorator,
              createAlovaEvent(2, methodInstance, sendCallingArgs, fromCache(), data, undefinedValue, 'success')
            );
          }
          return data;
        };

        // 中间件中未返回数据或返回undefined时，去获取真实的响应数据
        // 否则使用返回数据并不再等待响应promise，此时也需要调用响应回调
        if (middlewareReturnedData !== undefinedValue) {
          return afterSuccess(middlewareReturnedData);
        }
        if (!isNextCalled) {
          return;
        }

        // 当middlewareCompletePromise为resolve时有两种可能
        // 1. 请求正常
        // 2. 请求错误，但错误被中间件函数捕获了，此时也将调用成功回调，即afterSuccess(undefinedValue)
        return promiseThen(responseHandlePromise, afterSuccess, () => afterSuccess(undefinedValue));
      }),

      // catch回调函数
      (error: Error) => {
        if (toUpdateResponse()) {
          // 控制在输出错误消息
          sloughFunction(errorLogger, defaultErrorLogger)(error, methodInstance);
          const newStates = { error } as Partial<FrontRequestState<any, any, any, any, any>>;
          // loading状态受控时将不再更改为false
          !controlledLoading && (newStates.loading = falseValue);
          update(newStates, frontStates);
          runArgsHandler(
            errorHandlers,
            errorHandlerDecorator,
            createAlovaEvent(1, methodInstance, sendCallingArgs, fromCache(), undefinedValue, error)
          );
          runArgsHandler(
            completeHandlers,
            completeHandlerDecorator,
            createAlovaEvent(2, methodInstance, sendCallingArgs, fromCache(), undefinedValue, error, 'error')
          );
        }

        return promiseReject(error);
      }
    );

  return responseCompletePromise;
}
