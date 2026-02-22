import { useCallback, useMemo, useState } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { ApiClient } from '@/api/client'
import { useSessionDirectory } from '@/hooks/queries/useSessionDirectory'

type MoveToDialogProps = {
    isOpen: boolean
    onClose: () => void
    itemName: string
    itemPath: string
    api: ApiClient | null
    sessionId: string
    rootLabel: string
    onSubmit: (destinationDir: string) => Promise<void>
    isPending: boolean
}

function ChevronIcon(props: { collapsed: boolean; className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`${props.className ?? ''} transition-transform duration-200 ${props.collapsed ? '' : 'rotate-90'}`}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function FolderIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
    )
}

function DirectoryPickerNode(props: {
    api: ApiClient | null
    sessionId: string
    path: string
    label: string
    depth: number
    expanded: Set<string>
    selected: string | null
    excludePath: string
    onToggle: (path: string) => void
    onSelect: (path: string) => void
}) {
    const isExpanded = props.expanded.has(props.path)
    const isSelected = props.selected === props.path
    const isExcluded = props.path === props.excludePath || props.path.startsWith(props.excludePath + '/')

    const { entries, isLoading } = useSessionDirectory(props.api, props.sessionId, props.path, {
        enabled: isExpanded && !isExcluded
    })

    const directories = useMemo(
        () => entries.filter((entry) => entry.type === 'directory'),
        [entries]
    )

    const indent = 8 + props.depth * 16

    if (isExcluded) return null

    const handleClick = () => {
        props.onSelect(props.path)
        if (!isExpanded) {
            props.onToggle(props.path)
        }
    }

    const handleChevronClick = (event: React.MouseEvent) => {
        event.stopPropagation()
        props.onToggle(props.path)
    }

    return (
        <div>
            <div
                role="button"
                tabIndex={0}
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm transition-colors cursor-pointer select-none rounded-md ${
                    isSelected
                        ? 'bg-[var(--app-link)]/15 text-[var(--app-link)]'
                        : 'hover:bg-[var(--app-subtle-bg)]'
                }`}
                style={{ paddingLeft: indent }}
                onClick={handleClick}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        handleClick()
                    }
                }}
            >
                <span
                    role="button"
                    tabIndex={-1}
                    className="flex-shrink-0"
                    onClick={handleChevronClick}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            handleChevronClick(event as unknown as React.MouseEvent)
                        }
                    }}
                >
                    <ChevronIcon
                        collapsed={!isExpanded}
                        className="text-[var(--app-hint)]"
                    />
                </span>
                <FolderIcon className={isSelected ? 'text-[var(--app-link)]' : 'text-[var(--app-hint)]'} />
                <span className="truncate">{props.label}</span>
            </div>

            {isExpanded ? (
                isLoading ? (
                    <div
                        className="px-2 py-1 text-xs text-[var(--app-hint)] animate-pulse"
                        style={{ paddingLeft: indent + 16 }}
                    >
                        Loading...
                    </div>
                ) : (
                    directories.map((entry) => {
                        const childPath = props.path ? `${props.path}/${entry.name}` : entry.name
                        return (
                            <DirectoryPickerNode
                                key={childPath}
                                api={props.api}
                                sessionId={props.sessionId}
                                path={childPath}
                                label={entry.name}
                                depth={props.depth + 1}
                                expanded={props.expanded}
                                selected={props.selected}
                                excludePath={props.excludePath}
                                onToggle={props.onToggle}
                                onSelect={props.onSelect}
                            />
                        )
                    })
                )
            ) : null}
        </div>
    )
}

export function MoveToDialog(props: MoveToDialogProps) {
    const { isOpen, onClose, itemName, itemPath, api, sessionId, rootLabel, onSubmit, isPending } = props
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
    const [selected, setSelected] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    // Derive current parent from itemPath
    const currentParent = useMemo(() => {
        const parts = itemPath.split('/')
        return parts.slice(0, -1).join('/')
    }, [itemPath])

    // Reset state when dialog opens
    const handleOpenChange = useCallback((open: boolean) => {
        if (!open) {
            onClose()
            return
        }
        setExpanded(new Set(['']))
        setSelected(null)
        setError(null)
    }, [onClose])

    const handleToggle = useCallback((path: string) => {
        setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(path)) {
                next.delete(path)
            } else {
                next.add(path)
            }
            return next
        })
    }, [])

    const handleSelect = useCallback((path: string) => {
        setSelected(path)
        setError(null)
    }, [])

    const handleSubmit = async () => {
        if (selected === null) {
            setError('Select a destination folder')
            return
        }

        if (selected === currentParent) {
            setError('Item is already in this folder')
            return
        }

        setError(null)
        try {
            await onSubmit(selected)
            onClose()
        } catch (err) {
            const message = err instanceof Error && err.message
                ? err.message
                : 'Something went wrong'
            setError(message)
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={handleOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>Move to...</DialogTitle>
                    <DialogDescription className="mt-1">
                        Select a destination folder for <span className="font-medium">{itemName}</span>
                    </DialogDescription>
                </DialogHeader>

                <div className="mt-3 max-h-[50vh] overflow-y-auto rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] py-1">
                    <DirectoryPickerNode
                        api={api}
                        sessionId={sessionId}
                        path=""
                        label={rootLabel}
                        depth={0}
                        expanded={expanded}
                        selected={selected}
                        excludePath={itemPath}
                        onToggle={handleToggle}
                        onSelect={handleSelect}
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
                        disabled={isPending || selected === null}
                    >
                        {isPending ? 'Moving...' : 'Move'}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
