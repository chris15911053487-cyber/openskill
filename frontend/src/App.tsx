import { useEffect } from 'react';
import { useStore } from './store';
import { LoginView } from './views/LoginView';
import { RegisterView } from './views/RegisterView';
import { CatalogView } from './views/CatalogView';
import { SkillDetailView } from './views/SkillDetailView';
import { MySubscriptionsView } from './views/MySubscriptionsView';
import { UploadView } from './views/UploadView';
import { MyUploadsView } from './views/MyUploadsView';
import { CategoriesAdminView } from './views/CategoriesAdminView';
import { TagsAdminView } from './views/TagsAdminView';
import { ReviewQueueView } from './views/ReviewQueueView';
import { StatsView } from './views/StatsView';
import { UsersAdminView } from './views/UsersAdminView';
import { ChatView } from './views/ChatView';
import { MainLayout } from './components/MainLayout';
import { Toast } from './components/Toast';
import { Loader2 } from 'lucide-react';

export default function App() {
  const bootstrapping = useStore((s) => s.bootstrapping);
  const user = useStore((s) => s.user);
  const currentView = useStore((s) => s.currentView);
  const hydrate = useStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  if (bootstrapping) {
    return (
      <div className="min-h-full flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  // Unauthenticated: only allow login or register views
  if (!user) {
    if (currentView === 'register') return <><RegisterView /><Toast /></>;
    return (
      <>
        <LoginView />
        <Toast />
      </>
    );
  }

  // Authenticated routing
  let content;
  switch (currentView) {
    case 'login':
    case 'register':
    case 'catalog':
      content = <CatalogView />;
      break;
    case 'skill-detail':
      content = <SkillDetailView />;
      break;
    case 'my-subscriptions':
      content = <MySubscriptionsView />;
      break;
    case 'upload':
      content = <UploadView />;
      break;
    case 'my-uploads':
      content = <MyUploadsView />;
      break;
    case 'chat':
      content = <ChatView />;
      break;
    case 'admin-review':
    case 'admin-users':
    case 'admin-categories':
    case 'admin-tags':
    case 'admin-stats':
      // Admin guard — non-admins shouldn't be able to reach these via navigation,
      // but defend against direct state mutation just in case.
      if (user.role !== 'admin') content = <CatalogView />;
      else if (currentView === 'admin-categories') content = <CategoriesAdminView />;
      else if (currentView === 'admin-tags') content = <TagsAdminView />;
      else if (currentView === 'admin-review') content = <ReviewQueueView />;
      else if (currentView === 'admin-stats') content = <StatsView />;
      else content = <UsersAdminView />;
      break;
    default:
      content = <CatalogView />;
  }

  return (
    <>
      <MainLayout>{content}</MainLayout>
      <Toast />
    </>
  );
}
