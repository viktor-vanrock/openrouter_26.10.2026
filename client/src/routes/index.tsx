import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import {
  Login,
  VerifyEmail,
  Registration,
  ResetPassword,
  ApiErrorWatcher,
  TwoFactorScreen,
  RequestPasswordReset,
} from '~/components/Auth';
import { MarketplaceProvider } from '~/components/Agents/MarketplaceContext';
import AgentMarketplace from '~/components/Agents/Marketplace';
import { OAuthSuccess, OAuthError } from '~/components/OAuth';
import { AuthContextProvider } from '~/hooks/AuthContext';
import WithRum from '~/lib/rum/WithRum';
import RouteErrorBoundary from './RouteErrorBoundary';
import StartupLayout from './Layouts/Startup';
import LoginLayout from './Layouts/Login';
import dashboardRoutes from './Dashboard';
import ShareRoute from './ShareRoute';
import ChatRoute from './ChatRoute';
import Search from './Search';
import Root from './Root';
import { AdminRoute } from './AdminRoute';
import { AdminLayout } from '~/components/Admin/AdminLayout';
import { AdminDashboard } from '~/components/Admin/pages/Dashboard';
import { AdminUsers } from '~/components/Admin/pages/Users';
import AdminGuides from '~/components/Admin/guides/AdminGuides';
import GuideViewer from '~/components/Admin/guides/GuideViewer';
import { hasDevelopingCookie } from '~/utils/developingCookie';

const AuthLayout = () => (
  <AuthContextProvider>
    <WithRum>
      <Outlet />
    </WithRum>
    <ApiErrorWatcher />
  </AuthContextProvider>
);

const loadInlinePromptsView = () =>
  import('~/components/Prompts/layouts/InlinePromptsView').then((m) => ({
    Component: m.default,
  }));

const loadSkillsView = () =>
  import('~/components/Skills/layouts/SkillsView').then((m) => ({
    Component: m.default,
  }));

const loadGuideEditor = () =>
  import('~/components/Admin/guides/GuideEditor').then((m) => ({
    Component: m.default,
  }));

const loadAdminReleases = () => {
  if (!hasDevelopingCookie()) {
    return Promise.resolve({ Component: () => <Navigate to="/admin" replace /> });
  }
  return import('~/components/Admin/releases/AdminReleases').then((m) => ({
    Component: m.default,
  }));
};

const baseEl = document.querySelector('base');
const baseHref = baseEl?.getAttribute('href') || '/';

export const router = createBrowserRouter(
  [
    {
      path: 'share/:shareId',
      element: <ShareRoute />,
      errorElement: <RouteErrorBoundary />,
    },
    {
      path: 'oauth',
      errorElement: <RouteErrorBoundary />,
      children: [
        {
          path: 'success',
          element: <OAuthSuccess />,
        },
        {
          path: 'error',
          element: <OAuthError />,
        },
      ],
    },
    {
      path: '/',
      element: <StartupLayout />,
      errorElement: <RouteErrorBoundary />,
      children: [
        {
          path: 'register',
          element: <Registration />,
        },
        {
          path: 'forgot-password',
          element: <RequestPasswordReset />,
        },
        {
          path: 'reset-password',
          element: <ResetPassword />,
        },
      ],
    },
    {
      path: 'verify',
      element: <VerifyEmail />,
      errorElement: <RouteErrorBoundary />,
    },
    {
      element: <AuthLayout />,
      errorElement: <RouteErrorBoundary />,
      children: [
        {
          path: '/',
          element: <LoginLayout />,
          children: [
            {
              path: 'login',
              element: <Login />,
            },
            {
              path: 'login/2fa',
              element: <TwoFactorScreen />,
            },
          ],
        },
        dashboardRoutes,
        {
          path: 'admin',
          element: <AdminRoute />,
          children: [
            {
              element: <AdminLayout />,
              children: [
                { index: true, element: <AdminDashboard /> },
                { path: 'users', element: <AdminUsers /> },
                { path: 'guides', element: <AdminGuides /> },
                { path: 'guides/:id/edit', lazy: loadGuideEditor },
                { path: 'releases', lazy: loadAdminReleases },
              ],
            },
          ],
        },
        {
          path: '/',
          element: <Root />,
          children: [
            {
              index: true,
              element: <Navigate to="/c/new" replace={true} />,
            },
            {
              path: 'c/:conversationId?',
              element: <ChatRoute />,
            },
            {
              path: 'guide',
              element: <GuideViewer mode="published" />,
            },
            {
              path: 'search',
              element: <Search />,
            },
            {
              path: 'prompts',
              element: <Navigate to="/prompts/new" replace={true} />,
            },
            {
              path: 'prompts/new',
              lazy: loadInlinePromptsView,
            },
            {
              path: 'prompts/:promptId',
              lazy: loadInlinePromptsView,
            },
            {
              path: 'skills',
              lazy: loadSkillsView,
            },
            {
              path: 'skills/new',
              lazy: loadSkillsView,
            },
            {
              path: 'skills/:skillId',
              lazy: loadSkillsView,
            },
            {
              path: 'skills/:skillId/edit',
              lazy: loadSkillsView,
            },
            {
              path: 'agents',
              element: (
                <MarketplaceProvider>
                  <AgentMarketplace />
                </MarketplaceProvider>
              ),
            },
            {
              path: 'agents/:category',
              element: (
                <MarketplaceProvider>
                  <AgentMarketplace />
                </MarketplaceProvider>
              ),
            },
          ],
        },
        {
          path: 'guide/preview/:id',
          element: <AdminRoute />,
          children: [{ index: true, element: <GuideViewer mode="draft" /> }],
        },
      ],
    },
  ],
  { basename: baseHref },
);
