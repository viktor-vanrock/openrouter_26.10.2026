import { Routes, Route } from 'react-router-dom'

// Импортируй страницы здесь
// import { HomePage } from '@/pages/home'

export function App() {
  return (
    <Routes>
      <Route path="/" element={<div>Прототип готов к разработке</div>} />
    </Routes>
  )
}
