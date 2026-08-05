import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'

interface ModalProps {
  title: string
  subtitle?: string
  children: ReactNode
  onClose: () => void
  size?: 'small' | 'medium' | 'large'
}

export function Modal({ title, subtitle, children, onClose, size = 'medium' }: ModalProps) {
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [onClose])

  useEffect(() => {
    document.body.classList.add('has-modal')
    const frame = window.requestAnimationFrame(() => {
      window.focus()
      const firstControl = dialogRef.current?.querySelector<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
      )
      firstControl?.focus({ preventScroll: true })
    })
    return () => {
      window.cancelAnimationFrame(frame)
      document.body.classList.remove('has-modal')
    }
  }, [])

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className={`modal modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
      >
        <header className="modal__header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </header>
        <div className="modal__body">{children}</div>
      </section>
    </div>
  )
}
