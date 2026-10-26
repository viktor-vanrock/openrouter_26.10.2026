import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Input, Label, Modal, ModalContent, ModalHeader, ModalTitle, ModalBody, ModalFooter } from '@ai-sber/uikit'

export function App() {
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
    <article className="rounded-xl border p-6"><h2>{name}</h2><Button type="button" onClick={edit}>Редактировать</Button></article>
    <Modal open={open} onOpenChange={setOpen}><ModalContent><form onSubmit={save} noValidate>
      <ModalHeader><ModalTitle>Изменить сотрудника</ModalTitle></ModalHeader>
      <ModalBody><Label htmlFor="employee-name">Имя</Label><Input id="employee-name" value={draft} onChange={(event) => setDraft(event.target.value)} />{error && <p role="alert">{error}</p>}</ModalBody>
      <ModalFooter><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Отмена</Button><Button type="submit">Сохранить</Button></ModalFooter>
    </form></ModalContent></Modal>
  </main>
}
