/**
 * App 根组件
 *
 * 当前为空壳，显示 "Investment Tracker" 标题。
 * 后续在此集成路由（React Router）与全局状态（Zustand）。
 */

import type { FC } from 'react';

const App: FC = () => {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <h1 className="text-4xl font-bold text-foreground">
        Investment Tracker
      </h1>
    </div>
  );
};

export default App;
