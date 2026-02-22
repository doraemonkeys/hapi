import { useEffect, useRef, useState } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

type RenameDialogProps = {
    isOpen: boolean
    onClose: () => void
    currentName: string
    parentPath: string
    onSubmit: (newName: string) => Promise<void>
    isPending: boolean
}

const INVALID_CHARS = /[/\\]/
const MAX_NAME_LENGTH = 255

function validateName(name: string, currentName: string): string | null {
    const trimmed = name.trim()
    if (!trimmed) return 'Name cannot be empty'
    if (trimmed === '.' || trimmed === '..') return 'Invalid name'
    if (INVALID_CHARS.test(trimmed)) return 'Name cannot contain / or \\'
    if (trimmed.length > MAX_NAME_LENGTH) return 'Name is too long'
    if (trimmed === currentName) return 'Name is unchanged'
    return null
}

export function RenameDialog(props: RenameDialogProps) {
    const { isOpen, onClose, currentName, parentPath, onSubmit, isPending } = props
    const [name, setName] = useState(currentName)
    const [error, setError] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (!isOpen) return
        setName(currentName)
        setError(null)
        const frame = requestAnimationFrame(() => {
            const input = inputRef.current
            if (!input) return
            input.focus()
            // Select only the stem (before last dot) for files; entire name for directories
            const dotIndex = currentName.lastIndexOf('.')
            if (dotIndex > 0) {
                input.setSelectionRange(0, dotIndex)
            } else {
                input.select()
            }
        })
        return () => cancelAnimationFrame(frame)
    }, [isOpen, currentName])

    const handleSubmit = async () => {
        const validationError = validateName(name, currentName)
        if (validationError) {
            setError(validationError)
            return
        }

        setError(null)
        try {
            await onSubmit(name.trim())
            onClose()
        } catch (err) {
            const message = err instanceof Error && err.message
                ? err.message
                : 'Something went wrong'
            setError(message)
        }
    }

    const handleKeyDown = (event: React.KeyboardEvent) => {
        if (event.key === 'Enter' && !isPending) {
            event.preventDefault()
            void handleSubmit()
        }
    }

    const locationHint = parentPath || 'project root'

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>Rename</DialogTitle>
                    <DialogDescription className="mt-1">
                        in {locationHint}
                    </DialogDescription>
                </DialogHeader>

                <div className="mt-3">
                    <input
                        ref={inputRef}
                        value={name}
                        onChange={(event) => {
                            setName(event.target.value)
                            setError(null)
                        }}
                        onKeyDown={handleKeyDown}
                        className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                        autoCapitalize="none"
                        autoCorrect="off"
                        autoComplete="off"
                        disabled={isPending}
                    />
                </div>

                {error ? (
                    <div className="mt-2 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                        {error}
                    </div>
                ) : null}

                <div className="mt-4 flex gap-2 justify-end">
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onClose}
                        disabled={isPending}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        onClick={handleSubmit}
                        disabled={isPending || !name.trim()}
                    >
                        {isPending ? 'Renaming...' : 'Rename'}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
