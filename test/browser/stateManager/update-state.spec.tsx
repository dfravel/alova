import {
  createAlova,
  useRequest,
  GlobalFetch,
  ReactHook,
  update,
  VueHook,
} from '../../../src';
import { RequestConfig } from '../../../typings';
import { GetData, Result } from '../result.type';
import server from '../../server';
import { render, screen } from '@testing-library/react';
import React, { ReactElement } from 'react';
import '@testing-library/jest-dom';


beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
function getInstance(
  beforeRequestExpect?: (config: RequestConfig<any, any>) => void,
  responseExpect?: (jsonPromise: Promise<any>) => void,
  resErrorExpect?: (err: Error) => void,
) {
  return createAlova({
    baseURL: 'http://localhost:3000',
    timeout: 3000,
    statesHook: ReactHook,
    requestAdapter: GlobalFetch(),
    beforeRequest(config) {
      beforeRequestExpect && beforeRequestExpect(config);
      return config;
    },
    responsed: [response => {
      const jsonPromise = response.json();
      responseExpect && responseExpect(jsonPromise);
      return jsonPromise;
    }, err => {
      resErrorExpect && resErrorExpect(err);
    }]
  });
}
function getInstanceWithVue() {
  return createAlova({
    baseURL: 'http://localhost:3000',
    statesHook: VueHook,
    requestAdapter: GlobalFetch(),
    responsed: response => response.json(),
  });
}

describe('update cached response data by user', function() {
  test('the cached response data should be changed and the screen should be update', async () => {
    const alova = getInstance();
    const Get = alova.Get<GetData, Result>('/unit-test', {
      staleTime: 100000,
      transformData: data => data.data,
    });

    function Page() {
      const {
        data = { path: '' },
        onSuccess,
      } = useRequest(Get);
      onSuccess(() => update(Get, ([data, setData]) => {
        setData({
          ...data,
          path: '/unit-test-updated',
        });
      }));
      return <div role="path">{data.path}</div>;
    }
    render(<Page /> as ReactElement<any, any>);
    await screen.findByText(/unit-test/);
    // 延迟检查页面是否有更新
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(screen.getByRole('path')).toHaveTextContent('/unit-test-updated');
  });

  test('test update function with vue', async () => {
    const alova = getInstanceWithVue();
    const Get = alova.Get<GetData, Result>('/unit-test', {
      staleTime: 100000,
      transformData: data => data.data,
    });
    const { data, onSuccess } = useRequest(Get);
    await new Promise(resolve => onSuccess(() => resolve(1)));
    update(Get, data => {
      data.value.path = '/unit-test-updated';
    });
    expect(data.value.path).toBe('/unit-test-updated');
  });
});