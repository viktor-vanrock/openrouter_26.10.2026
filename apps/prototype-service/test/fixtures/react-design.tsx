import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Input, Label, Modal, ModalContent, ModalHeader, ModalTitle, ModalBody, ModalFooter } from '@ai-sber/uikit'

export function App() {
  const [variant, setVariant] = useState('A')
  const [name, setName] = useState('Иван Петров')
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const edit = () => { setDraft(name); setError(''); setOpen(true) }
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!draft.trim()) { setError('Введите имя'); return }
    setName(draft.trim()); setOpen(false)
  }
  return <main className="p-6">
    <h1>React dev prototype</h1>
    <section aria-label="Варианты дизайна" className="flex gap-2 my-4">
      <Button type="button" variant={variant === 'A' ? 'primary' : 'secondary'} aria-pressed={variant === 'A'} onClick={() => setVariant('A')}>A — Таблица</Button>
      <Button type="button" variant={variant === 'B' ? 'primary' : 'secondary'} aria-pressed={variant === 'B'} onClick={() => setVariant('B')}>B — Карточки</Button>
    </section>
    <section data-prototype-variant={variant}>
      {variant === 'A' ? <table><tbody><tr><td>{name}</td><td><Button type="button" onClick={edit}>Редактировать</Button></td></tr></tbody></table>
        : <article className="rounded-xl border p-6"><h2>{name}</h2><Button type="button" onClick={edit}>Редактировать</Button></article>}
    </section>
    <Modal open={open} onOpenChange={setOpen}><ModalContent><form onSubmit={save} noValidate>
      <ModalHeader><ModalTitle>Изменить сотрудника</ModalTitle></ModalHeader>
      <ModalBody><Label htmlFor="employee-name">Имя</Label><Input id="employee-name" value={draft} onChange={(event) => setDraft(event.target.value)} />{error && <p role="alert">{error}</p>}</ModalBody>
      <ModalFooter><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Отмена</Button><Button type="submit">Сохранить</Button></ModalFooter>
    </form></ModalContent></Modal>
  </main>
}
