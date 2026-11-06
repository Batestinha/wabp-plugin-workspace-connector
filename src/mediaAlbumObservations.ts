/** Some WhatsApp clients send an album as consecutive media without a wrapper. */
export class MediaAlbumObservations {
  private readonly bursts = new Map<string, { startedAt: number; ids: Set<string>; emitted: boolean }>();

  observe(input: { scopeId: string; chatId: string; actorIdentityId: string; messageId: string; messageType: string; hasMedia: boolean; receivedAt: Date }): boolean {
    const now = input.receivedAt.getTime();
    for (const [key, burst] of this.bursts) if (now - burst.startedAt > 10_000) this.bursts.delete(key);
    const key = JSON.stringify([input.scopeId, input.chatId, input.actorIdentityId]);
    const type = input.messageType.toLowerCase();
    if (type !== 'album' && (!input.hasMedia || !['image', 'video'].includes(type))) return false;
    let burst = this.bursts.get(key);
    if (!burst) {
      if (this.bursts.size >= 1_000) this.bursts.delete(this.bursts.keys().next().value!);
      burst = { startedAt: now, ids: new Set(), emitted: false };
      this.bursts.set(key, burst);
    }
    if (burst.emitted || burst.ids.has(input.messageId)) return false;
    burst.ids.add(input.messageId);
    if (type !== 'album' && burst.ids.size < 3) return false;
    burst.emitted = true;
    return true;
  }
}
