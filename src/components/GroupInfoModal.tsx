import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useConnection } from '../context';
import { useEscapeKey } from '../useEscapeKey';
import { formatProfileDate } from '../utils';
import { Avatar } from './Avatar';

export interface GroupInfoModalProps {
  open: boolean;
  groupId: string | null;
  onClose: () => void;
  onGroupDeleted?: () => void;
  onGroupLeft?: () => void;
}

export function GroupInfoModal({ open, groupId, onClose, onGroupDeleted, onGroupLeft }: GroupInfoModalProps) {
  const { state, getGroupInfo, getGroupMembers, addGroupMember, removeGroupMember, updateGroup, deleteGroup, leaveGroup, t } = useConnection();
  const [group, setGroup] = useState<any>(null);
  const [editingName, setEditingName] = useState('');
  const [editingDesc, setEditingDesc] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEscapeKey(onClose, open, 80);

  useEffect(() => {
    if (!open || !groupId) return;
    setError(null);
    getGroupInfo(groupId);
    getGroupMembers(groupId);
  }, [open, groupId, getGroupInfo, getGroupMembers]);

  useEffect(() => {
    if (groupId) {
      const g = state.groups.find((x) => x.id === groupId);
      if (g) setGroup(g);
    }
  }, [groupId, state.groups]);

  const members = state.groupMembers;
  const myMember = members.find((m: any) => m.userId === state.userId);
  const isAdmin = myMember ? (myMember.role === 'admin' || myMember.role === 'owner') : false;
  const isCreator = group?.createdBy === state.userId;

  const handleLeave = async () => {
    if (!groupId) return;
    if (!confirm(t('leave_group_confirm'))) return;
    setBusy(true);
    leaveGroup(groupId);
    setBusy(false);
    onClose();
    onGroupLeft?.();
  };

  const handleDelete = async () => {
    if (!groupId) return;
    if (!confirm(t('delete_group_confirm'))) return;
    setBusy(true);
    deleteGroup(groupId);
    setBusy(false);
    onClose();
    onGroupDeleted?.();
  };

  const handleSave = async () => {
    if (!groupId) return;
    setBusy(true);
    updateGroup(groupId, {
      name: editingName.trim() || undefined,
      description: editingDesc.trim() || undefined,
    });
    setBusy(false);
    setEditingName('');
    setEditingDesc('');
  };

  const handleRemoveMember = (member: any) => {
    if (member.userId === state.userId) {
      setError(t('cannot_remove_self'));
      return;
    }
    if (member.role === 'admin' && !isCreator) {
      setError(t('cannot_remove_admin'));
      return;
    }
    if (!confirm(t('remove_member_confirm', { name: member.nickname || member.userId }))) return;
    setBusy(true);
    removeGroupMember(groupId!, member.userId);
    setBusy(false);
  };

  const handleMakeAdmin = (member: any) => {
    setBusy(true);
    addGroupMember(groupId!, member.userId, 'admin');
    setBusy(false);
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-bg-secondary border border-border-default rounded-2xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-4 border-b border-border-default flex justify-between items-start">
          <button onClick={onClose} className="p-2 rounded-full text-fg-muted hover:bg-bg-tertiary transition-colors" aria-label={t('close')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
          {group && (
            <div className="flex items-center gap-3">
              <Avatar userId={group.id} nickname={group.name} avatar={{ ext: null, updatedAt: null }} className="w-10 h-10 rounded-full" textClassName="text-[10px]" />
              <div>
                <div className="text-[15px] font-bold text-fg-primary truncate max-w-xs">@{group.name}</div>
                <div className="text-[11px] text-fg-muted">{group.myRole === 'admin' ? t('admin') : t('member')} • {group.memberCount} {t('members')} • {group.isChannel ? t('channel') : t('group')}</div>
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 space-y-4">
          {group && (
            <>
              <div className="px-4 py-3 rounded-xl bg-bg-tertiary border border-border-default">
                <div className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider mb-2">{t('group_info')}</div>
                <div className="space-y-2">
                  <div className="flex justify-between text-[13px]">
                    <span className="text-fg-muted">{t('created')}</span>
                    <span className="text-fg-primary">{formatProfileDate(group.createdAt)}</span>
                  </div>
                  <div className="flex justify-between text-[13px]">
                    <span className="text-fg-muted">{t('creator')}</span>
                    <span className="text-fg-primary">@{group.createdBy}</span>
                  </div>
                  <div className="flex justify-between text-[13px]">
                    <span className="text-fg-muted">{t('invite_code')}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono bg-bg-secondary/50 px-2 py-1 rounded">{group.inviteCode || '-'}</span>
                      <button onClick={() => { }} className="p-1 text-fg-muted hover:text-accent-primary" title={t('copy_invite')}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {isAdmin && (
                <>
                  <div className="px-4 py-3 rounded-xl bg-bg-tertiary border border-border-default">
                    <div className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider mb-2">{t('edit_group')}</div>
                    <input
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      placeholder={t('group_name')}
                      className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-default text-fg-primary focus:outline-none focus:ring-2 focus:ring-accent-primary mb-2"
                    />
                    <textarea
                      value={editingDesc}
                      onChange={(e) => setEditingDesc(e.target.value)}
                      placeholder={t('group_description')}
                      rows={2}
                      className="w-full px-3 py-2 rounded-lg bg-bg-secondary border border-border-default text-fg-primary focus:outline-none focus:ring-2 focus:ring-accent-primary mb-3 resize-none"
                    />
                    <button
                      onClick={handleSave}
                      disabled={busy}
                      className="w-full py-2 rounded-lg bg-accent-primary text-accent-text text-[13px] font-medium hover:bg-accent-primary/90 transition-colors disabled:opacity-50"
                    >
                      {t('save')}
                    </button>
                  </div>

                  <div className="px-4 py-3 rounded-xl bg-bg-tertiary border border-border-default">
                    <div className="flex justify-between items-center mb-3">
                      <div className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider">{t('members')}</div>
                      <button
                        onClick={() => { }}
                        className="text-[12px] text-accent-primary hover:text-accent-primary/90"
                      >
                        {t('add_members')}
                      </button>
                    </div>
                    <div className="space-y-1">
                      {members.map((m: any) => (
                        <div key={m.userId} className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-bg-secondary/50 transition-colors">
                          <div className="flex items-center gap-2">
                            <Avatar userId={m.userId} nickname={m.nickname || m.userId} avatar={{ ext: null, updatedAt: null }} className="w-8 h-8 rounded-full" textClassName="text-[9px]" />
                            <div>
                              <div className="text-[13px] font-medium text-fg-primary">{m.nickname || m.userId}</div>
                              <div className="text-[11px] text-fg-muted">{m.role}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            {m.role !== 'owner' && (
                              <button
                                onClick={() => handleRemoveMember(m)}
                                className="p-1.5 text-status-error hover:bg-status-error/10 rounded-lg transition-colors"
                                title={t('remove_member')}
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-status-error))" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M4.93 4.93l14.14 14.14" /></svg>
                              </button>
                            )}
                            {m.role !== 'admin' && isAdmin && (
                              <button
                                onClick={() => handleMakeAdmin(m)}
                                className="p-1.5 text-accent-primary hover:bg-accent-primary/10 rounded-lg transition-colors"
                                title={t('make_admin')}
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-accent-primary))" strokeWidth="2"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" /></svg>
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="pt-4">
                    <button
                      onClick={handleLeave}
                      disabled={busy}
                      className="w-full py-3 rounded-xl border border-status-error/40 text-status-error text-[14px] font-medium hover:bg-status-error/10 transition-colors disabled:opacity-50"
                    >
                      {t('leave_group')}
                    </button>
                    {isCreator && (
                      <button
                        onClick={handleDelete}
                        disabled={busy}
                        className="w-full py-3 rounded-xl border border-status-error/40 text-status-error text-[14px] font-medium hover:bg-status-error/10 transition-colors mt-2 disabled:opacity-50"
                      >
                        {t('delete_group')}
                      </button>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {error && <p className="px-4 text-[12px] text-status-error">{error}</p>}
          {busy && <p className="px-4 text-[12px] text-fg-muted">{t('loading')}</p>}
        </div>
      </div>
    </div>,
    document.body
  );
}
