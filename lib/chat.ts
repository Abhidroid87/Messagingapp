import { supabase } from './supabase';
import { EncryptionManager } from './encryption';
import { AuthManager, UserProfile } from './auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { markActive } from './activity';

export interface Chat {
  id: string;
  name?: string;
  is_group: boolean;
  created_by: string;
  group_key_version: number;
  created_at: string;
  updated_at: string;
  participants?: ChatParticipant[] | string[];
  last_message?: string;
  last_message_at?: string;
}

export interface ChatParticipant {
  id: string;
  chat_id: string;
  user_id: string;
  role: 'admin' | 'member';
  joined_at: string;
  left_at?: string;
  profile?: UserProfile;
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
  content?: string;
  status?: MessageStatus[];
}

export interface MessageStatus {
  id: string;
  message_id: string;
  user_id: string;
  status: 'sent' | 'delivered' | 'seen';
  updated_at: string;
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

  private async loadChatsFromStorage(): Promise<void> {
    try {
      const chatsData = await AsyncStorage.getItem('local_chats');
      const messagesData = await AsyncStorage.getItem('local_messages');

      if (chatsData) {
        const chatsArray: Chat[] = JSON.parse(chatsData);
        chatsArray.forEach(chat => {
          this.chats.set(chat.id, chat);
        });
      }

      if (messagesData) {
        const messagesMap: Record<string, Message[]> = JSON.parse(messagesData);
        Object.entries(messagesMap).forEach(([chatId, messages]) => {
          this.messages.set(chatId, messages);
        });
      }
    } catch (error) {
      console.error('Failed to load chats from storage:', error);
    }
  }

  private async saveChatsToStorage(): Promise<void> {
    try {
      const chatsArray = Array.from(this.chats.values());
      const messagesMap: Record<string, Message[]> = {};

      this.messages.forEach((messages, chatId) => {
        messagesMap[chatId] = messages;
      });

      await AsyncStorage.setItem('local_chats', JSON.stringify(chatsArray));
      await AsyncStorage.setItem('local_messages', JSON.stringify(messagesMap));
    } catch (error) {
      console.error('Failed to save chats to storage:', error);
    }
  }

  private startRetryMechanism(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
    }

    this.retryTimer = setInterval(async () => {
      await this.retryPendingMessages();
    }, 30000);
  }

  private async loadPendingMessages(): Promise<void> {
    try {
      const stored = await AsyncStorage.getItem('pending_messages');
      if (stored) {
        const messages: PendingMessage[] = JSON.parse(stored);
        messages.forEach(msg => {
          this.pendingMessages.set(msg.id, msg);
        });
      }
    } catch (error) {
      console.error('Failed to load pending messages:', error);
    }
  }

  private async savePendingMessages(): Promise<void> {
    try {
      const messages = Array.from(this.pendingMessages.values());
      await AsyncStorage.setItem('pending_messages', JSON.stringify(messages));
    } catch (error) {
      console.error('Failed to save pending messages:', error);
    }
  }

  private async retryPendingMessages(): Promise<void> {
    const messages = Array.from(this.pendingMessages.values());

    for (const message of messages) {
      if (message.retry_count < 5) {
        try {
          await this.sendMessage(
            message.chat_id,
            message.content,
            message.message_type,
            message.file_data,
            message.file_name
          );

          this.pendingMessages.delete(message.id);
        } catch (error) {
          message.retry_count++;
          this.pendingMessages.set(message.id, message);
        }
      } else {
        this.pendingMessages.delete(message.id);
      }
    }

    await this.savePendingMessages();
  }

  async createChat(participantIds: string[], isGroup: boolean = false, name?: string): Promise<Chat> {
    const { data: { session } } = await supabase.auth.getSession();
    const authUid = session?.user?.id;

    if (!authUid) {
      throw new Error('User not authenticated');
    }

    try {
      if (!participantIds || participantIds.length === 0) {
        throw new Error('At least one participant is required');
      }

      const profileIds: string[] = [];
      for (const participantId of participantIds) {
        if (!isNaN(Number(participantId))) {
          const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id, username, public_key')
            .eq('user_id', parseInt(participantId))
            .single();

          if (profileError || !profile) {
            throw new Error(`User with ID ${participantId} not found`);
          }
          profileIds.push(profile.id);
        } else {
          const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id, username, public_key')
            .eq('id', participantId)
            .single();

          if (profileError || !profile) {
            throw new Error(`Profile with ID ${participantId} not found`);
          }
          profileIds.push(profile.id);
        }
      }

      const { data: participants, error: participantsError } = await supabase
        .from('profiles')
        .select('id, username, public_key')
        .in('id', profileIds);

      if (participantsError || !participants) {
        throw new Error('Failed to verify participants');
      }

      if (participants.length !== profileIds.length) {
        throw new Error('One or more participants not found');
      }

      const { data: newChatData, error: chatError } = await supabase
        .from('chats')
        .insert({
          name: isGroup ? name : null,
          is_group: isGroup,
          created_by: authUid,
        })
        .select()
        .single();

      if (chatError || !newChatData) {
        throw new Error('Failed to create chat in database');
      }

      const allParticipants = [authUid, ...profileIds];
      const participantInserts = allParticipants.map(userId => ({
        chat_id: newChatData.id,
        user_id: userId,
        role: userId === authUid ? 'admin' : 'member',
      }));

      const { error: participantsInsertError } = await supabase
        .from('chat_participants')
        .insert(participantInserts);

      if (participantsInsertError) {
        await supabase.from('chats').delete().eq('id', newChatData.id);
        throw new Error('Failed to add participants to chat');
      }

      const newChat: Chat = {
        id: newChatData.id,
        name: isGroup ? name : undefined,
        is_group: isGroup,
        created_by: authUid,
        participants: allParticipants,
        created_at: newChatData.created_at,
        updated_at: newChatData.updated_at,
      };

      this.chats.set(newChat.id, newChat);
      this.messages.set(newChat.id, []);

      await this.saveChatsToStorage();
      await markActive(authUid);

      return newChat;
    } catch (error) {
      console.error('Chat creation error:', error);
      if (error instanceof Error) throw error;
      throw new Error('Failed to create chat: Unknown error');
    }
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
    if (!authUid) {
      throw new Error('User not authenticated');
    }

    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      const chat = this.chats.get(chatId);
      if (!chat) {
        throw new Error('Chat not found');
      }

      if (!chat.participants?.includes(authUid)) {
        throw new Error('User is not a participant in this chat');
      }

      const { data: participantProfiles } = await supabase
        .from('profiles')
        .select('id, public_key')
        .in('id', (chat.participants as string[]).filter(id => id !== authUid));

      const participantKeys = participantProfiles?.map(p => p.public_key) || [];

      const encryptedContent = this.encryptionManager.encryptMessage(
        content,
        chatId,
        participantKeys
      );

      let encryptedFileData: string | undefined;
      let fileKey: string | undefined;

      if (fileData && messageType !== 'text') {
        const fileEncryption = this.encryptionManager.encryptFile(fileData);
        encryptedFileData = fileEncryption.encrypted;
        fileKey = fileEncryption.key;
      }

      const message: Message = {
        id: messageId,
        chat_id: chatId,
        sender_id: authUid,
        message_type: messageType,
        file_name: fileName,
        file_size: fileData ? fileData.length : undefined,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        content,
      };

      const chatMessages = this.messages.get(chatId) || [];
      chatMessages.push(message);
      this.messages.set(chatId, chatMessages);

      chat.last_message = content.substring(0, 100);
      chat.last_message_at = message.created_at;
      chat.updated_at = message.created_at;
      this.chats.set(chatId, chat);

      await this.saveChatsToStorage();
      await markActive(authUid);

      return message;
    } catch (error) {
      const pendingMessage: PendingMessage = {
        id: messageId,
        chat_id: chatId,
        content,
        message_type: messageType,
        file_data: fileData,
        file_name: fileName,
        retry_count: 0,
        created_at: new Date().toISOString(),
      };

      this.pendingMessages.set(messageId, pendingMessage);
      await this.savePendingMessages();

      throw new Error(`Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getChatMessages(chatId: string, limit: number = 50): Promise<Message[]> {
    try {
      const messages = this.messages.get(chatId) || [];
      return messages
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, limit);
    } catch (error) {
      console.error('Failed to get messages:', error);
      return [];
    }
  }

  async getUserChats(): Promise<Chat[]> {
    const { data: { session } } = await supabase.auth.getSession();
    const authUid = session?.user?.id;
    if (!authUid) return [];

    try {
      const { data: chatData, error: chatsError } = await supabase
        .from('chats')
        .select(`*, chat_participants!inner(user_id, role)`)
        .eq('chat_participants.user_id', authUid)
        .order('updated_at', { ascending: false });

      if (chatsError) {
        const userChats = Array.from(this.chats.values())
          .filter(chat => chat.participants?.includes(authUid))
          .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
        return userChats;
      }

      if (!chatData) return [];

      const userChats: Chat[] = [];

      for (const chat of chatData) {
        const { data: allParticipants } = await supabase
          .from('chat_participants')
          .select('user_id')
          .eq('chat_id', chat.id);

        const participantIds = allParticipants?.map(p => p.user_id) || [];

        const chatObj: Chat = {
          id: chat.id,
          name: chat.name,
          is_group: chat.is_group,
          created_by: chat.created_by,
          participants: participantIds,
          created_at: chat.created_at,
          updated_at: chat.updated_at,
        };

        userChats.push(chatObj);
        this.chats.set(chat.id, chatObj);
      }

      await this.saveChatsToStorage();
      return userChats;
    } catch (error) {
      const userChats = Array.from(this.chats.values())
        .filter(chat => chat.participants?.includes(authUid))
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      return userChats;
    }
  }

  async addGroupMember(chatId: string, userId: string): Promise<void> {
    const { data: { session } } = await supabase.auth.getSession();
    const authUid = session?.user?.id;
    if (!authUid) throw new Error('User not authenticated');

    try {
      const chat = this.chats.get(chatId);
      if (!chat) throw new Error('Chat not found');

      if (!chat.is_group) throw new Error('Cannot add members to direct chat');
      if (chat.created_by !== authUid) throw new Error('Only chat creator can add members');

      const { data: userProfile } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', userId)
        .single();

      if (!userProfile) throw new Error('User not found');

      if (!chat.participants?.includes(userId)) {
        (chat.participants as string[]).push(userId);
        chat.updated_at = new Date().toISOString();
        this.chats.set(chatId, chat);
        await this.saveChatsToStorage();
      }
    } catch (error) {
      throw new Error(`Failed to add member: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }


  // Remove member from group chat
  async removeGroupMember(chatId: string, userId: string): Promise<void> {
    const currentUser = this.authManager.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    try {
      const chat = this.chats.get(chatId);
      if (!chat) throw new Error('Chat not found');

      if (!chat.is_group) throw new Error('Cannot remove members from direct chat');
      if (chat.created_by !== currentUser.id) throw new Error('Only chat creator can remove members');

      // Remove from participants
      chat.participants = chat.participants.filter(id => id !== userId);
      chat.updated_at = new Date().toISOString();
      this.chats.set(chatId, chat);
      await this.saveChatsToStorage();
    } catch (error) {
      throw new Error(`Failed to remove member: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Subscribe to chat updates (mock implementation for local storage)
  subscribeToChat(chatId: string, onMessage: (message: any) => void): () => void {
    // In a real implementation, this would use WebSockets or Server-Sent Events
    // For now, return a no-op unsubscribe function
    return () => {};
  }

  // Cleanup expired messages
  static async cleanupExpiredMessages(): Promise<void> {
    // This would clean up messages older than their expiry date
    // Implementation depends on storage strategy
  }

  // Clear all pending messages
  async clearPendingMessages(): Promise<void> {
    this.pendingMessages.clear();
    await AsyncStorage.removeItem('pending_messages');
  }

  // Get pending messages count
  getPendingMessagesCount(): number {
    return this.pendingMessages.size;
  }

  // Clear all chats (for logout)
  async clearAllChats(): Promise<void> {
    this.chats.clear();
    this.messages.clear();
    this.pendingMessages.clear();
    await AsyncStorage.multiRemove(['local_chats', 'local_messages', 'pending_messages']);
  }

  // Destroy chat manager
  destroy(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    this.pendingMessages.clear();
  }
}