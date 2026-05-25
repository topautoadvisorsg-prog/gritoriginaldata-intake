import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import Dashboard from './pages/Dashboard';
import Fighters from './pages/Fighters';
import FighterDetail from './pages/FighterDetail';
import News from './pages/News';
import Events from './pages/Events';
import Monitor from './pages/Monitor';
import Odds from './pages/Odds';
import Images from './pages/Images';
import PipelineReview from './pages/PipelineReview';
import ManualIngest from './pages/ManualIngest';

function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/"             element={<Dashboard />} />
        <Route path="/review"       element={<PipelineReview />} />
        <Route path="/ingest"       element={<ManualIngest />} />
        <Route path="/fighters"     element={<Fighters />} />
        <Route path="/fighters/:id" element={<FighterDetail />} />
        <Route path="/events"       element={<Events />} />
        <Route path="/news"         element={<News />} />
        <Route path="/odds"         element={<Odds />} />
        <Route path="/images"       element={<Images />} />
        <Route path="/monitor"      element={<Monitor />} />
      </Routes>
    </Layout>
  );
}

export default App;
