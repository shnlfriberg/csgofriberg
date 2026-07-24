import { ReactElement, ReactNode } from 'react';
import { render, RenderOptions } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import { ConfirmProvider } from '../components/ConfirmDialog';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <ConfirmProvider>{children}</ConfirmProvider>
    </I18nextProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) {
  return render(ui, {
    wrapper: ({ children }) => <Providers>{children}</Providers>,
    ...options,
  });
}

export function renderAtRoute(
  ui: ReactElement,
  {
    route = '/',
    path = '/',
    extraRoutes,
  }: {
    route?: string;
    path?: string;
    extraRoutes?: ReactElement;
  } = {}
) {
  return renderWithProviders(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path={path} element={ui} />
        {extraRoutes}
      </Routes>
    </MemoryRouter>
  );
}
