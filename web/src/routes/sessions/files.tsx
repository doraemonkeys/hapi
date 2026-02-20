import { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { DirectoryTree } from '@/components/SessionFiles/DirectoryTree'
import { CreateItemDialog } from '@/components/SessionFiles/CreateItemDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useGitStatusFiles } from '@/hooks/queries/useGitStatusFiles'
import { useSession } from '@/hooks/queries/useSession'
import { useSessionFileSearch } from '@/hooks/queries/useSessionFileSearch'
import { useFileOperations } from '@/hooks/mutations/useFileOperations'
import { useToast } from '@/lib/toast-context'
import { encodeBase64 } from '@/lib/utils'
import { queryKeys } from '@/lib/query-keys'
import { useQueryClient } from '@tanstack/react-query'
import {
    BackIcon,
    CreateMenu,
    type CreateMenuState,
    FileListSkeleton,
    GitBranchIcon,
    GitFileRow,
    PlusIcon,
    RefreshIcon,
    SearchIcon,
    SearchResultRow,
} from './files-ui'

export default function FilesPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const goBack = useAppGoBack()
    const { sessionId } = useParams({ from: '/sessions/$sessionId/files' })
    const search = useSearch({ from: '/sessions/$sessionId/files' })
    const { session } = useSession(api, sessionId)
    const { addToast } = useToast()
    const [searchQuery, setSearchQuery] = useState('')

    const initialTab = search.tab === 'directories' ? 'directories' : 'changes'
    const [activeTab, setActiveTab] = useState<'changes' | 'directories'>(initialTab)

    const fileOps = useFileOperations(api, sessionId)

    // Track last-expanded directory for "+" button context
    const targetPathRef = useRef('')

    // Create dialog state
    const [createDialog, setCreateDialog] = useState<{
        isOpen: boolean
        itemType: 'file' | 'folder'
        parentPath: string
    }>({ isOpen: false, itemType: 'file', parentPath: '' })

    // Delete confirm state
    const [deleteConfirm, setDeleteConfirm] = useState<{
        isOpen: boolean
        path: string
        name: string
        type: 'file' | 'directory'
    }>({ isOpen: false, path: '', name: '', type: 'file' })

    // Tracks the last successfully deleted path for DirectoryTree cleanup
    const [lastDeletedPath, setLastDeletedPath] = useState<string>('')

    // Create picker menu state
    const [createMenu, setCreateMenu] = useState<CreateMenuState>(null)

    const {
        status: gitStatus,
        error: gitError,
        isLoading: gitLoading,
        refetch: refetchGit
    } = useGitStatusFiles(api, sessionId)

    const shouldSearch = Boolean(searchQuery)

    const searchResults = useSessionFileSearch(api, sessionId, searchQuery, {
        enabled: shouldSearch
    })

    const handleOpenFile = useCallback((path: string, staged?: boolean) => {
        const fileSearch = staged === undefined
            ? (activeTab === 'directories'
                ? { path: encodeBase64(path), tab: 'directories' as const }
                : { path: encodeBase64(path) })
            : (activeTab === 'directories'
                ? { path: encodeBase64(path), staged, tab: 'directories' as const }
                : { path: encodeBase64(path), staged })
        navigate({
            to: '/sessions/$sessionId/file',
            params: { sessionId },
            search: fileSearch
        })
    }, [activeTab, navigate, sessionId])

    const branchLabel = gitStatus?.branch ?? 'detached'
    const subtitle = session?.metadata?.path ?? sessionId
    const showGitErrorBanner = Boolean(gitError)
    const rootLabel = useMemo(() => {
        const base = session?.metadata?.path ?? sessionId
        const parts = base.split(/[/\\]/).filter(Boolean)
        return parts.length ? parts[parts.length - 1] : base
    }, [session?.metadata?.path, sessionId])

    const handleRefresh = useCallback(() => {
        if (searchQuery) {
            void queryClient.invalidateQueries({
                queryKey: queryKeys.sessionFiles(sessionId, searchQuery)
            })
            return
        }

        if (activeTab === 'directories') {
            void queryClient.invalidateQueries({
                queryKey: ['session-directory', sessionId]
            })
            return
        }

        void refetchGit()
    }, [activeTab, queryClient, refetchGit, searchQuery, sessionId])

    const handleTabChange = useCallback((nextTab: 'changes' | 'directories') => {
        setActiveTab(nextTab)
        navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId },
            search: nextTab === 'changes' ? {} : { tab: nextTab },
            replace: true,
        })
    }, [navigate, sessionId])

    // "+" button handler
    const handlePlusClick = useCallback((event: React.MouseEvent) => {
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
        setCreateMenu({
            isOpen: true,
            anchorPoint: { x: rect.right, y: rect.bottom + 4 }
        })
    }, [])

    // Tree action callbacks
    const treeActions = useMemo(() => ({
        onNewFile: (parentPath: string) => {
            setCreateDialog({ isOpen: true, itemType: 'file', parentPath })
        },
        onNewFolder: (parentPath: string) => {
            setCreateDialog({ isOpen: true, itemType: 'folder', parentPath })
        },
        onDeleteItem: (path: string, name: string, type: 'file' | 'directory') => {
            setDeleteConfirm({ isOpen: true, path, name, type })
        },
    }), [])

    const handleCreateSubmit = useCallback(async (name: string) => {
        const { itemType, parentPath } = createDialog
        if (itemType === 'file') {
            await fileOps.createFile(parentPath, name)
        } else {
            await fileOps.createFolder(parentPath, name)
        }
        addToast({
            title: `Created ${name}`,
            body: `${itemType === 'file' ? 'File' : 'Folder'} created successfully`,
            sessionId,
            url: `/sessions/${sessionId}/files?tab=directories`
        })
    }, [createDialog, fileOps, addToast, sessionId])

    const handleDeleteConfirm = useCallback(async () => {
        const { path, name, type } = deleteConfirm
        if (type === 'file') {
            await fileOps.deleteFile(path)
        } else {
            await fileOps.deleteFolder(path)
        }
        // Clean up stale targetPathRef (P2) and trigger DirectoryTree expanded cleanup (P3)
        if (targetPathRef.current === path || targetPathRef.current.startsWith(path + '/')) {
            targetPathRef.current = ''
        }
        setLastDeletedPath(path)
        addToast({
            title: `Deleted ${name}`,
            body: `${type === 'file' ? 'File' : 'Folder'} deleted successfully`,
            sessionId,
            url: `/sessions/${sessionId}/files?tab=directories`
        })
    }, [deleteConfirm, fileOps, addToast, sessionId])

    return (
        <div className="flex h-full flex-col">
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 p-3 border-b border-[var(--app-border)]">
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">Files</div>
                        <div className="truncate text-xs text-[var(--app-hint)]">{subtitle}</div>
                    </div>
                    {activeTab === 'directories' && !searchQuery ? (
                        <button
                            type="button"
                            onClick={handlePlusClick}
                            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                            title="New file or folder"
                        >
                            <PlusIcon />
                        </button>
                    ) : null}
                    <button
                        type="button"
                        onClick={handleRefresh}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        title="Refresh"
                    >
                        <RefreshIcon />
                    </button>
                </div>
            </div>

            <div className="bg-[var(--app-bg)]">
                <div className="mx-auto w-full max-w-content p-3 border-b border-[var(--app-border)]">
                    <div className="flex items-center gap-2 rounded-md bg-[var(--app-subtle-bg)] px-3 py-2">
                        <SearchIcon className="text-[var(--app-hint)]" />
                        <input
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder="Search files"
                            className="w-full bg-transparent text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none"
                            autoCapitalize="none"
                            autoCorrect="off"
                        />
                    </div>
                </div>
            </div>

            <div className="bg-[var(--app-bg)] border-b border-[var(--app-divider)]" role="tablist">
                <div className="mx-auto w-full max-w-content grid grid-cols-2">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'changes'}
                        onClick={() => handleTabChange('changes')}
                        className={`relative py-3 text-center text-sm font-semibold transition-colors hover:bg-[var(--app-subtle-bg)] ${activeTab === 'changes' ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                    >
                        Changes
                        <span
                            className={`absolute bottom-0 left-1/2 h-0.5 w-10 -translate-x-1/2 rounded-full ${activeTab === 'changes' ? 'bg-[var(--app-link)]' : 'bg-transparent'}`}
                        />
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'directories'}
                        onClick={() => handleTabChange('directories')}
                        className={`relative py-3 text-center text-sm font-semibold transition-colors hover:bg-[var(--app-subtle-bg)] ${activeTab === 'directories' ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                    >
                        Directories
                        <span
                            className={`absolute bottom-0 left-1/2 h-0.5 w-10 -translate-x-1/2 rounded-full ${activeTab === 'directories' ? 'bg-[var(--app-link)]' : 'bg-transparent'}`}
                        />
                    </button>
                </div>
            </div>

            {!gitLoading && gitStatus && !searchQuery && activeTab === 'changes' ? (
                <div className="bg-[var(--app-bg)]">
                    <div className="mx-auto w-full max-w-content px-3 py-2 border-b border-[var(--app-divider)]">
                        <div className="flex items-center gap-2 text-sm">
                            <GitBranchIcon className="text-[var(--app-hint)]" />
                            <span className="font-semibold">{branchLabel}</span>
                        </div>
                        <div className="text-xs text-[var(--app-hint)]">
                            {gitStatus.totalStaged} staged, {gitStatus.totalUnstaged} unstaged
                        </div>
                    </div>
                </div>
            ) : null}

            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-content">
                    {showGitErrorBanner && activeTab === 'changes' ? (
                        <div className="border-b border-[var(--app-divider)] bg-amber-500/10 px-3 py-2 text-xs text-[var(--app-hint)]">
                            {gitError}
                        </div>
                    ) : null}
                    {shouldSearch ? (
                        searchResults.isLoading ? (
                            <FileListSkeleton label="Loading files..." />
                        ) : searchResults.error ? (
                            <div className="p-6 text-sm text-[var(--app-hint)]">{searchResults.error}</div>
                        ) : searchResults.files.length === 0 ? (
                            <div className="p-6 text-sm text-[var(--app-hint)]">
                                {searchQuery ? 'No files match your search.' : 'No files found in this project.'}
                            </div>
                        ) : (
                            <div className="border-t border-[var(--app-divider)]">
                                {searchResults.files.map((file, index) => (
                                    <SearchResultRow
                                        key={`${file.fullPath}-${index}`}
                                        file={file}
                                        onOpen={() => handleOpenFile(file.fullPath)}
                                        showDivider={index < searchResults.files.length - 1}
                                    />
                                ))}
                            </div>
                        )
                    ) : activeTab === 'directories' ? (
                        <DirectoryTree
                            api={api}
                            sessionId={sessionId}
                            rootLabel={rootLabel}
                            onOpenFile={(path) => handleOpenFile(path)}
                            actions={treeActions}
                            onTargetPathChange={(path) => { targetPathRef.current = path }}
                            lastDeletedPath={lastDeletedPath}
                        />
                    ) : gitLoading ? (
                        <FileListSkeleton label="Loading Git status..." />
                    ) : (
                        <div>
                            {gitStatus?.stagedFiles.length ? (
                                <div>
                                    <div className="border-b border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-xs font-semibold text-[var(--app-git-staged-color)]">
                                        Staged Changes ({gitStatus.stagedFiles.length})
                                    </div>
                                    {gitStatus.stagedFiles.map((file, index) => (
                                        <GitFileRow
                                            key={`staged-${file.fullPath}-${index}`}
                                            file={file}
                                            onOpen={() => handleOpenFile(file.fullPath, file.isStaged)}
                                            showDivider={index < gitStatus.stagedFiles.length - 1 || gitStatus.unstagedFiles.length > 0}
                                        />
                                    ))}
                                </div>
                            ) : null}

                            {gitStatus?.unstagedFiles.length ? (
                                <div>
                                    <div className="border-b border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-xs font-semibold text-[var(--app-git-unstaged-color)]">
                                        Unstaged Changes ({gitStatus.unstagedFiles.length})
                                    </div>
                                    {gitStatus.unstagedFiles.map((file, index) => (
                                        <GitFileRow
                                            key={`unstaged-${file.fullPath}-${index}`}
                                            file={file}
                                            onOpen={() => handleOpenFile(file.fullPath, file.isStaged)}
                                            showDivider={index < gitStatus.unstagedFiles.length - 1}
                                        />
                                    ))}
                                </div>
                            ) : null}

                            {!gitStatus ? (
                                <div className="p-6 text-sm text-[var(--app-hint)]">
                                    Git status unavailable. Use Directories to browse all files, or search.
                                </div>
                            ) : null}

                            {gitStatus && gitStatus.stagedFiles.length === 0 && gitStatus.unstagedFiles.length === 0 ? (
                                <div className="p-6 text-sm text-[var(--app-hint)]">
                                    No changes detected. Use Directories to browse all files, or search.
                                </div>
                            ) : null}
                        </div>
                    )}
                </div>
            </div>

            {/* "+" button dropdown menu */}
            <CreateMenu
                state={createMenu}
                onClose={() => setCreateMenu(null)}
                onNewFile={() => setCreateDialog({ isOpen: true, itemType: 'file', parentPath: targetPathRef.current })}
                onNewFolder={() => setCreateDialog({ isOpen: true, itemType: 'folder', parentPath: targetPathRef.current })}
            />

            {/* Create file/folder dialog */}
            <CreateItemDialog
                isOpen={createDialog.isOpen}
                onClose={() => setCreateDialog((prev) => ({ ...prev, isOpen: false }))}
                itemType={createDialog.itemType}
                parentPath={createDialog.parentPath}
                onSubmit={handleCreateSubmit}
                isPending={fileOps.isPending}
            />

            {/* Delete confirmation dialog */}
            <ConfirmDialog
                isOpen={deleteConfirm.isOpen}
                onClose={() => setDeleteConfirm((prev) => ({ ...prev, isOpen: false }))}
                title={`Delete ${deleteConfirm.name}?`}
                description={
                    deleteConfirm.type === 'directory'
                        ? 'This will permanently delete this folder and all its contents. This cannot be undone.'
                        : 'This will permanently delete this file. This cannot be undone.'
                }
                confirmLabel="Delete"
                confirmingLabel="Deleting..."
                onConfirm={handleDeleteConfirm}
                isPending={fileOps.isPending}
                destructive
            />
        </div>
    )
}
