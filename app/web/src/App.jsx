import { useAuth } from './lib/store.jsx';
import AuthPage from './components/AuthPage.jsx';
import ChatPage from './components/ChatPage.jsx';

export default function App() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" />
        <p>加载中…</p>
      </div>
    );
  }
  return user ? <ChatPage /> : <AuthPage />;
}