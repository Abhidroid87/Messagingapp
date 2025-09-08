import { supabase } from './supabase';
import { EncryptionManager } from './encryption';
import { AuthManager } from './auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { markActive } from './activity';

export interface Chat {
  id: string;
  name?: string | null;
  is_group: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  participants: string[]; // store participant UUIDs locally
}

export interface Message {
  id: string;
  chat_id: string;
  sender_id: string;
  message_type: 'text' | 'file' | 'image' | 'audio' | 'video';
  file_name?: string;
  file_size?: number;
  reply_to?: string;
  created_at: string;
  expires_at: string;
  content?: string; // decrypted content (local only)
}

export interface PendingMessage {
  id: string;
  chat_id: string;
  content: string;
  message_type: 'text' | 'file' | 'image' | 'audio' | 'video';
  file_data?: string;
  file_name?: string;
  retry_count: number;
  created_at: string;
}

export class ChatManager {
  private static instance: ChatManager;
  private encryptionManager: EncryptionManager;
  private authManager: AuthManager;
  private pendingMessages: Map<string, PendingMessage> = new Map();
  private chats: Map<string, Chat> = new Map();
  private messages: Map<string, Message[]> = new Map();
  private retryTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.encryptionManager = EncryptionManager.getInstance();
    this.authManager = AuthManager.getInstance();
    this.loadChatsFromStorage();
    this.startRetryMechanism();
  }

  static getInstance(): ChatManager {
    if (!ChatManager.instance) {
      ChatManager.instance = new ChatManager();
    }
    return ChatManager.instance;
  }

  // ------------------- storage helpers -------------------
  private async loadChatsFromStorage(): Promise<void> {
    try {
      const chatsData = await AsyncStorage.getItem('local_chats');
      const messagesData = await AsyncStorage.getItem('local_messages');
      if (chatsData) JSON.parse(chatsData).forEach((c: Chat) => this.chats.set(c.id, c));
      if (messagesData) {
        const map: Record<string, Message[]> = JSON.parse(messagesData);
        Object.entries(map).forEach(([chatId, msgs]) => this.messages.set(chatId, msgs));
      }
    } catch (e) {
      console.error('Failed to load chats:', e);
    }
  }

  private async saveChatsToStorage(): Promise<void> {
    try {
      await AsyncStorage.setItem('local_chats', JSON.stringify(Array.from(this.chats.values())));
      const msgMap: Record<string, Message[]> = {};
      this.messages.forEach((v, k) => (msgMap[k] = v));
      await AsyncStorage.setItem('local_messages', JSON.stringify(msgMap));
    } catch (e) {
      console.error('Failed to save chats:', e);
    }
  }

  private startRetryMechanism(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = setInterval(() => this.retryPendingMessages(), 30000);
  }

  private async loadPendingMessages(): Promise<void> {
    try {
      const stored = await AsyncStorage.getItem('pending_messages');
      if (stored) {
        const messages: PendingMessage[] = JSON.parse(stored);
        messages.forEach(m => this.pendingMessages.set(m.id, m));
      }
    } catch (e) {
      console.error('Failed to load pending messages:', e);
    }
  }

  private async savePendingMessages(): Promise<void> {
    try {
      await AsyncStorage.setItem('pending_messages', JSON.stringify(Array.from(this.pendingMessages.values())));
    } catch (e) {
      console.error('Failed to save pending messages:', e);
    }
  }

  private async retryPendingMessages(): Promise<void> {
    const items = Array.from(this.pendingMessages.values());
    for (const m of items) {
      if (m.retry_count < 5) {
        try {
          await this.sendMessage(m.chat_id, m.content, m.message_type, m.file_data, m.file_name);
          this.pendingMessages.delete(m.id);
        } catch {
          m.retry_count += 1;
          this.pendingMessages.set(m.id, m);
        }
      } else {
        this.pendingMessages.delete(m.id);
      }
    }
    await this.savePendingMessages();
  }

  // ------------------- chat operations -------------------

  // Create a chat. participantIds can be uuid (profiles.id) or 8-digit user_id strings.
  async createChat(participantIds: string[], isGroup: boolean = false, name?: string): Promise<Chat> {
    const { data: { session } } = await supabase.auth.getSession();
    const authUid = session?.user?.id;
    if (!authUid) throw new Error('User not authenticated');

    if (!participantIds || participantIds.length === 0) throw new Error('At least one participant is required');

    // Resolve to profile UUIDs
    const resolvedIds: string[] = [];
    for (const raw of participantIds) {
      if (/^\d+$/.test(raw)) {
        // looks like bigint user_id
        const { data, error } = await supabase.from('profiles').select('id').eq('user_id', Number(raw)).maybeSingle();
        if (error || !data) throw new Error(`User with app ID ${raw} not found`);
        resolvedIds.push(data.id);
      } else {
        // assume uuid, verify
        const { data, error } = await supabase.from('profiles').select('id').eq('id', raw).maybeSingle();
        if (error || !data) throw new Error(`Profile ${raw} not found`);
        resolvedIds.push(data.id);
      }
    }

    // For DM, check if a chat already exists with exactly these two users
    if (!isGroup && resolvedIds.length === 1) {
      const { data: existing, error: existErr } = await supabase
        .from('chats')
        .select('id, is_group, chat_participants!inner(user_id)')
        .eq('is_group', false);

      if (!existErr && existing) {
        for (const row of existing as any[]) {
          const ids: string[] = row.chat_participants.map((p: any) => p.user_id);
          const match = ids.length === 2 && ids.includes(authUid) && ids.includes(resolvedIds[0]);
          if (match) {
            // hydrate minimal local structure
            const chat: Chat = { id: row.id, name: null, is_group: false, created_by: authUid, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), participants: ids };
            this.chats.set(chat.id, chat);
            await this.saveChatsToStorage();
            return chat;
          }
        }
      }
    }

    // Create new chat
    const { data: newChat, error: chatErr } = await supabase
      .from('chats')
      .insert({ name: isGroup ? (name ?? null) : null, is_group: isGroup, created_by: authUid })
      .select()
      .single();

    if (chatErr || !newChat) {
      console.error('Chat creation error details:', chatErr);
      throw new Error(`Failed to create chat in database: ${chatErr?.message || 'Unknown'}`);
    }

    // Add participants (creator as admin)
    const allIds = [authUid, ...resolvedIds];
    const rows = allIds.map(uid => ({ chat_id: newChat.id, user_id: uid, role: uid === authUid ? 'admin' : 'member' }));
    const { error: partErr } = await supabase.from('chat_participants').insert(rows);
    if (partErr) {
      // cleanup chat row if participant insertion fails
      await supabase.from('chats').delete().eq('id', newChat.id);
      throw new Error(`Failed to add participants: ${partErr.message}`);
    }

    const chat: Chat = {
      id: newChat.id,
      name: isGroup ? (name ?? null) : null,
      is_group: isGroup,
      created_by: authUid,
      created_at: newChat.created_at,
      updated_at: newChat.updated_at,
      participants: allIds,
    };

    this.chats.set(chat.id, chat);
    this.messages.set(chat.id, []);
    await this.saveChatsToStorage();
    await markActive(authUid);
    return chat;
  }

  async sendMessage(
    chatId: string,
    content: string,
    messageType: 'text' | 'file' | 'image' | 'audio' | 'video' = 'text',
    fileData?: string,
    fileName?: string
  ): Promise<Message> {
    const { data: { session } } = await supabase.auth.getSession();
    const authUid = session?.user?.id;
    if (!authUid) throw new Error('User not authenticated');

    const chat = this.chats.get(chatId);
    if (!chat) throw new Error('Chat not found');

    // ensure sender is a participant
    if (!chat.participants.includes(authUid)) throw new Error('User is not a participant in this chat');

    // Encrypt to other participants' keys
    const { data: participantProfiles } = await supabase
      .from('profiles')
      .select('id, public_key')
      .in('id', chat.participants.filter(id => id !== authUid));

    const keys = (participantProfiles || []).map(p => (p as any).public_key);
    const encrypted = this.encryptionManager.encryptMessage(content, chatId, keys);

    const message: Message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      chat_id: chatId,
      sender_id: authUid,
      message_type: messageType,
      file_name: fileName,
      file_size: fileData ? fileData.length : undefined,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      content, // local plaintext copy
    };

    const msgs = this.messages.get(chatId) || [];
    msgs.push(message);
    this.messages.set(chatId, msgs);

    // Update chat metadata & persist
    chat.updated_at = message.created_at;
    this.chats.set(chatId, chat);
    await this.saveChatsToStorage();
    await markActive(authUid);

    // TODO: Persist message to DB (if schema includes messages insert under RLS)
    return message;
  }

  async getChatMessages(chatId: string, limit: number = 50): Promise<Message[]> {
    const items = this.messages.get(chatId) || [];
    return items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, limit);
  }

  async getUserChats(): Promise<Chat[]> {
    const { data: { session } } = await supabase.auth.getSession();
    const authUid = session?.user?.id;
    if (!authUid) return [];

    const { data, error } = await supabase
      .from('chats')
      .select('id, name, is_group, created_by, created_at, updated_at, chat_participants!inner(user_id)')
      .eq('chat_participants.user_id', authUid)
      .order('updated_at', { ascending: false });

    if (error || !data) {
      // fallback to local cache
      return Array.from(this.chats.values())
        .filter(c => c.participants.includes(authUid))
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    }

    const chats: Chat[] = [];
    for (const row of data as any[]) {
      // fetch all participants
      const { data: all } = await supabase.from('chat_participants').select('user_id').eq('chat_id', row.id);
      const ids = (all || []).map(p => p.user_id);
      const c: Chat = {
        id: row.id,
        name: row.name,
        is_group: row.is_group,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        participants: ids,
      };
      chats.push(c);
      this.chats.set(c.id, c);
    }
    await this.saveChatsToStorage();
    return chats;
  }

  async clearAllChats(): Promise<void> {
    this.chats.clear();
    this.messages.clear();
    this.pendingMessages.clear();
    await AsyncStorage.multiRemove(['local_chats', 'local_messages', 'pending_messages']);
  }

  destroy(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    this.pendingMessages.clear();
  }
}