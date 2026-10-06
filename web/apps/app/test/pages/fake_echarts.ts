/** A stand-in for the ECharts chunk in component tests: happy-dom has no canvas to draw on. */
const instance = {
  on: () => undefined,
  setOption: () => undefined,
  dispatchAction: () => undefined,
  resize: () => undefined,
  dispose: () => undefined,
  getDataURL: () => "data:image/png;base64,",
};

export const echarts = { init: () => instance };
