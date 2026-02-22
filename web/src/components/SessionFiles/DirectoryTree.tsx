import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { FileIcon } from '@/components/FileIcon'
import { FileActionMenu } from '@/components/SessionFiles/FileActionMenu'
import { useSessionDirectory } from '@/hooks/queries/useSessionDirectory'
import { useLongPress } from '@/hooks/useLongPress'

function ChevronIcon(props: { className?: string; collapsed: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
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
            width="22"
            height="22"
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

function DirectorySkeleton(props: { depth: number; rows?: number }) {
    const rows = props.rows ?? 4
    const indent = 12 + props.depth * 14

    return (
        <div className="animate-pulse">
            {Array.from({ length: rows }).map((_, index) => (
                <div
                    key={`dir-skel-${props.depth}-${index}`}
                    className="flex items-center gap-3 px-3 py-2"
                    style={{ paddingLeft: indent }}
                >
                    <div className="h-5 w-5 rounded bg-[var(--app-subtle-bg)]" />
                    <div className="h-3 w-40 rounded bg-[var(--app-subtle-bg)]" />
                </div>
            ))}
        </div>
    )
}

function DirectoryErrorRow(props: { depth: number; message: string }) {
    const indent = 12 + props.depth * 14
    return (
        <div
            className="px-3 py-2 text-xs text-[var(--app-hint)] bg-amber-500/10"
            style={{ paddingLeft: indent }}
        >
            {props.message}
        </div>
    )
}

type ActionMenuState = {
    isOpen: boolean
    anchorPoint: { x: number; y: number }
    itemPath: string
    itemName: string
    itemType: 'file' | 'directory'
} | null

type DirectoryTreeActions = {
    onNewFile: (parentPath: string) => void
    onNewFolder: (parentPath: string) => void
    onDeleteItem: (path: string, name: string, type: 'file' | 'directory') => void
    onRenameItem: (path: string, name: string, type: 'file' | 'directory') => void
    onMoveItem: (path: string, name: string, type: 'file' | 'directory') => void
}

function FileRow(props: {
    filePath: string
    name: string
    indent: number
    onOpenFile: (path: string) => void
    onLongPress: (point: { x: number; y: number }, path: string, name: string) => void
}) {
    const longPressHandlers = useLongPress({
        onLongPress: (point) => props.onLongPress(point, props.filePath, props.name),
        onClick: () => props.onOpenFile(props.filePath),
    })

    return (
        <div
            role="button"
            tabIndex={0}
            className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors cursor-pointer select-none"
            style={{ paddingLeft: props.indent }}
            {...longPressHandlers}
        >
            <span className="h-4 w-4" />
            <FileIcon fileName={props.name} size={22} />
            <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{props.name}</div>
            </div>
        </div>
    )
}

function DirectoryNode(props: {
    api: ApiClient | null
    sessionId: string
    path: string
    label: string
    depth: number
    onOpenFile: (path: string) => void
    expanded: Set<string>
    onToggle: (path: string) => void
    onDirLongPress: (point: { x: number; y: number }, path: string, name: string) => void
    onFileLongPress: (point: { x: number; y: number }, path: string, name: string) => void
}) {
    const isExpanded = props.expanded.has(props.path)
    const { entries, error, isLoading } = useSessionDirectory(props.api, props.sessionId, props.path, {
        enabled: isExpanded
    })

    const directories = useMemo(() => entries.filter((entry) => entry.type === 'directory'), [entries])
    const files = useMemo(() => entries.filter((entry) => entry.type === 'file'), [entries])
    const childDepth = props.depth + 1

    const indent = 12 + props.depth * 14
    const childIndent = 12 + childDepth * 14

    const longPressHandlers = useLongPress({
        onLongPress: (point) => props.onDirLongPress(point, props.path, props.label),
        onClick: () => props.onToggle(props.path),
    })

    return (
        <div>
            <div
                role="button"
                tabIndex={0}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors cursor-pointer select-none"
                style={{ paddingLeft: indent }}
                {...longPressHandlers}
            >
                <ChevronIcon collapsed={!isExpanded} className="text-[var(--app-hint)]" />
                <FolderIcon className="text-[var(--app-link)]" />
                <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{props.label}</div>
                </div>
            </div>

            {isExpanded ? (
                isLoading ? (
                    <DirectorySkeleton depth={childDepth} />
                ) : error ? (
                    <DirectoryErrorRow depth={childDepth} message={error} />
                ) : (
                    <div>
                        {directories.map((entry) => {
                            const childPath = props.path ? `${props.path}/${entry.name}` : entry.name
                            return (
                                <DirectoryNode
                                    key={childPath}
                                    api={props.api}
                                    sessionId={props.sessionId}
                                    path={childPath}
                                    label={entry.name}
                                    depth={childDepth}
                                    onOpenFile={props.onOpenFile}
                                    expanded={props.expanded}
                                    onToggle={props.onToggle}
                                    onDirLongPress={props.onDirLongPress}
                                    onFileLongPress={props.onFileLongPress}
                                />
                            )
                        })}

                        {files.map((entry) => {
                            const filePath = props.path ? `${props.path}/${entry.name}` : entry.name
                            return (
                                <FileRow
                                    key={filePath}
                                    filePath={filePath}
                                    name={entry.name}
                                    indent={childIndent}
                                    onOpenFile={props.onOpenFile}
                                    onLongPress={props.onFileLongPress}
                                />
                            )
                        })}

                        {directories.length === 0 && files.length === 0 ? (
                            <div
                                className="px-3 py-2 text-sm text-[var(--app-hint)]"
                                style={{ paddingLeft: childIndent }}
                            >
                                Empty directory.
                            </div>
                        ) : null}
                    </div>
                )
            ) : null}
        </div>
    )
}

export function DirectoryTree(props: {
    api: ApiClient | null
    sessionId: string
    rootLabel: string
    onOpenFile: (path: string) => void
    actions?: DirectoryTreeActions
    onTargetPathChange?: (path: string) => void
    lastDeletedPath?: string
}) {
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
    const [actionMenu, setActionMenu] = useState<ActionMenuState>(null)

    // Clean up expanded state after a successful delete
    useEffect(() => {
        if (!props.lastDeletedPath) return
        setExpanded((prev) => {
            const next = new Set(prev)
            for (const key of prev) {
                if (key === props.lastDeletedPath || key.startsWith(props.lastDeletedPath + '/')) {
                    next.delete(key)
                }
            }
            return next
        })
    }, [props.lastDeletedPath])

    const handleToggle = useCallback((path: string) => {
        setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(path)) {
                next.delete(path)
            } else {
                next.add(path)
                // Report last-expanded directory to parent
                props.onTargetPathChange?.(path)
            }
            return next
        })
    }, [props.onTargetPathChange])

    const handleDirLongPress = useCallback((point: { x: number; y: number }, path: string, name: string) => {
        setActionMenu({ isOpen: true, anchorPoint: point, itemPath: path, itemName: name, itemType: 'directory' })
    }, [])

    const handleFileLongPress = useCallback((point: { x: number; y: number }, path: string, name: string) => {
        setActionMenu({ isOpen: true, anchorPoint: point, itemPath: path, itemName: name, itemType: 'file' })
    }, [])

    const closeMenu = useCallback(() => {
        setActionMenu(null)
    }, [])

    const handleDelete = useCallback(() => {
        if (!actionMenu || !props.actions) return
        const { itemPath, itemName, itemType } = actionMenu
        closeMenu()
        props.actions.onDeleteItem(itemPath, itemName, itemType)
    }, [actionMenu, closeMenu, props.actions])

    const handleRename = useCallback(() => {
        if (!actionMenu || !props.actions) return
        const { itemPath, itemName, itemType } = actionMenu
        closeMenu()
        props.actions.onRenameItem(itemPath, itemName, itemType)
    }, [actionMenu, closeMenu, props.actions])

    const handleMoveTo = useCallback(() => {
        if (!actionMenu || !props.actions) return
        const { itemPath, itemName, itemType } = actionMenu
        closeMenu()
        props.actions.onMoveItem(itemPath, itemName, itemType)
    }, [actionMenu, closeMenu, props.actions])

    return (
        <div className="border-t border-[var(--app-divider)]">
            <DirectoryNode
                api={props.api}
                sessionId={props.sessionId}
                path=""
                label={props.rootLabel}
                depth={0}
                onOpenFile={props.onOpenFile}
                expanded={expanded}
                onToggle={handleToggle}
                onDirLongPress={handleDirLongPress}
                onFileLongPress={handleFileLongPress}
            />

            {actionMenu && props.actions ? (
                <FileActionMenu
                    isOpen={actionMenu.isOpen}
                    onClose={closeMenu}
                    anchorPoint={actionMenu.anchorPoint}
                    itemType={actionMenu.itemType}
                    onNewFile={actionMenu.itemType === 'directory'
                        ? () => {
                            const path = actionMenu.itemPath
                            closeMenu()
                            props.actions!.onNewFile(path)
                        }
                        : undefined}
                    onNewFolder={actionMenu.itemType === 'directory'
                        ? () => {
                            const path = actionMenu.itemPath
                            closeMenu()
                            props.actions!.onNewFolder(path)
                        }
                        : undefined}
                    onRename={handleRename}
                    onMoveTo={handleMoveTo}
                    onDelete={handleDelete}
                />
            ) : null}
        </div>
    )
}
