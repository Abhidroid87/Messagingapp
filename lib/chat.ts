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
  participants?: ChatParticipant[];
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
  content?: string; // Decrypted content (not stored in DB)
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

  // Load chats from local storage
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

  // Save chats to local storage
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

  // Start retry mechanism for failed messages
  private startRetryMechanism(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
    }

    this.retryTimer = setInterval(async () => {
      await this.retryPendingMessages();
    }, 30000); // Retry every 30 seconds
  }

  // Load pending messages from storage
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

  // Save pending messages to storage
  private async savePendingMessages(): Promise<void> {
    try {
      const messages = Array.from(this.pendingMessages.values());
      await AsyncStorage.setItem('pending_messages', JSON.stringify(messages));
    } catch (error) {
      console.error('Failed to save pending messages:', error);
    }
  }

  // Retry sending pending messages
  private async retryPendingMessages(): Promise<void> {
    const messages = Array.from(this.pendingMessages.values());
    
    for (const message of messages) {
      if (message.retry_count < 5) { // Max 5 retries
        try {
          await this.sendMessage(
            message.chat_id,
            message.content,
            message.message_type,
            message.file_data,
            message.file_name
          );
          
          // Remove from pending if successful
          this.pendingMessages.delete(message.id);
        } catch (error) {
          // Increment retry count
          message.retry_count++;
          this.pendingMessages.set(message.id, message);
        }
      } else {
        // Remove after max retries
        this.pendingMessages.delete(message.id);
      }
    }

    await this.savePendingMessages();
  }

  // Create a new chat
  async createChat(participantIds: string[], isGroup: boolean = false, name?: string): Promise<Chat> {
    const currentUser = await this.authManager.getCurrentUserSafe();
    if (!currentUser) {
      throw new Error('User not authenticated. Please log in to create chats.');
    }

    console.log('🔐 ChatManager: Creating chat for user:', {
      userId: currentUser.id,
      username: currentUser.username
    });

    try {
      // Validate participant IDs and convert user_ids to profile UUIDs if needed
      if (!participantIds || participantIds.length === 0) {
        throw new Error('At least one participant is required');
      }

      // Check if participantIds are user_ids (numbers) or profile UUIDs
      const profileIds: string[] = [];
      
      for (const participantId of participantIds) {
        // If it's a number, it's a user_id, so we need to get the profile UUID
        if (!isNaN(Number(participantId))) {
          const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id, username, public_key')
            .eq('user_id', parseInt(participantId))
            .single();
            
          if (profileError || !profile) {
            console.error('Profile lookup error:', profileError?.message || 'Profile not found');
            throw new Error(`User with ID ${participantId} not found`);
          }
          profileIds.push(profile.id);
        } else {
          // It's already a UUID, verify it exists
          const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('id, username, public_key')
            .eq('id', participantId)
            .single();
            
          if (profileError || !profile) {
            console.error('Profile verification error:', profileError?.message || 'Profile not found');
            throw new Error(`Profile with ID ${participantId} not found`);
          }
          profileIds.push(profile.id);
        }
      }

      // Verify all participants exist
      const { data: participants, error: participantsError } = await supabase
        .from('profiles')
        .select('id, username, public_key')
        .in('id', profileIds);

      if (participantsError || !participants) {
        console.error('Error fetching participants:', participantsError?.message || 'Unknown error');
        throw new Error('Failed to verify participants');
      }

      if (participants.length !== profileIds.length) {
        throw new Error('One or more participants not found');
      }

      // For direct messages, check if chat already exists
      if (!isGroup && profileIds.length === 1) {
        const { data: existingChat, error: existingChatError } = await supabase
          .from('chats')
          .select(`
            *,
            chat_participants!inner(user_id)
          `)
          .eq('is_group', false)
          .not('chat_participants.user_id', 'is', null);
          
        if (existingChat && !existingChatError) {
          // Check if this chat has exactly the two participants we want
          for (const chat of existingChat) {
            const chatParticipants = (chat as any).chat_participants.map((p: any) => p.user_id);
            if (chatParticipants.length === 2 && 
                chatParticipants.includes(user.id) && 
                chatParticipants.includes(profileIds[0])) {
              // Convert to our Chat interface
              const existingChatData: Chat = {
                id: chat.id,
                name: chat.name,
                is_group: chat.is_group,
                created_by: chat.created_by,
                participants: chatParticipants,
                created_at: chat.created_at,
                updated_at: chat.updated_at,
              };
              return existingChatData;
            }
          }
        }
      }

      // Create new chat in database using the authenticated user's ID
      const { data: newChatData, error: chatError } = await supabase
        .from('chats')
        .insert({
          name: isGroup ? name : null,
          is_group: isGroup,
          created_by: currentUser.id, // Use current user profile ID
        })
        .select()
        .single();

      if (chatError || !newChatData) {
        console.error('Chat creation error:', chatError?.message || 'Unknown error', chatError);
        throw new Error(`Failed to create chat in database: ${chatError?.message || 'Unknown error'}`);
      }

      // First, add the creator as admin
      const { error: creatorInsertError } = await supabase
        .from('chat_participants')
        .insert({
          chat_id: newChatData.id,
          user_id: currentUser.id,
          role: 'admin',
        });

      if (creatorInsertError) {
        console.error('Creator participant insert error:', creatorInsertError?.message || 'Unknown error', creatorInsertError);
        // Clean up the chat if creator insertion failed
        await supabase.from('chats').delete().eq('id', newChatData.id);
        throw new Error(`Failed to add creator to chat: ${creatorInsertError?.message || 'Unknown error'}`);
      }

      // Then add other participants as members
      if (profileIds.length > 0) {
        const participantInserts = profileIds.map(userId => ({
          chat_id: newChatData.id,
          user_id: userId,
          role: 'member',
        }));

        const { error: participantsInsertError } = await supabase
          .from('chat_participants')
          .insert(participantInserts);

        if (participantsInsertError) {
          console.error('Participants insert error:', participantsInsertError?.message || 'Unknown error', participantsInsertError);
          // Clean up the chat if participant insertion failed
          await supabase.from('chats').delete().eq('id', newChatData.id);
          throw new Error(`Failed to add participants to chat: ${participantsInsertError?.message || 'Unknown error'}`);
        }
      }

      // Build the complete participants list for local storage
      const allParticipants = [currentUser.id, ...profileIds];
      const newChat: Chat = {
        id: newChatData.id,
        name: isGroup ? name : undefined,
        is_group: isGroup,
        created_by: currentUser.id,
        participants: allParticipants,
        created_at: newChatData.created_at,
        updated_at: newChatData.updated_at,
      };

      // Store chat locally
      this.chats.set(newChat.id, newChat);
      this.messages.set(newChat.id, []);
      
      // Save to storage
      await this.saveChatsToStorage();
      
      // Try to persist message to database (if Supabase is configured)
      try {
        const { data: inserted, error: insertError } = await supabase
          .from('messages')
          .insert({
            id: message.id,
            chat_id: message.chat_id,
            sender_id: message.sender_id,
            message_type: message.message_type,
            file_name: message.file_name || null,
            file_size: message.file_size || null,
            reply_to: message.reply_to || null,
            created_at: message.created_at,
            expires_at: message.expires_at,
            content: encryptedContent || message.content || null
          })
          .select()
          .single();

        if (insertError) {
          console.warn('Failed to persist message to DB - will retry later:', insertError.message || insertError);
          // Add to pending messages for retry
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
        } else {
          // Optionally record sender's message status as 'sent'
          try {
            const { error: statusErr } = await supabase
              .from('message_statuses')
              .upsert({
                message_id: messageId,
                user_id: currentUser.id,
                status: 'sent',
                updated_at: new Date().toISOString()
              }, { onConflict: ['message_id','user_id'] });
            if (statusErr) console.warn('Failed to set initial message status:', statusErr);
          } catch (e) {
            console.warn('Status upsert failed:', e);
          }
        }
      } catch (dbErr) {
        console.warn('Database unavailable, queued message for retry:', dbErr);
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
      }

      // Mark user active after sending
      await markActive(currentUser.id);s.saveChatsToStorage();

      // Mark user as active
      await markActive(currentUser.id);

      return newChat;
    } catch (error) {
      console.error('Chat creation error:', error instanceof Error ? error.message : 'Unknown error', error);
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error('Failed to create chat: Unknown error');
      }
    }
  }

  // Find existing direct chat between two users
  private findExistingDirectChat(userId1: string, userId2: string): Chat | null {
    for (const chat of this.chats.values()) {
      if (!chat.is_group && 
          chat.participants.length === 2 &&
          chat.participants.includes(userId1) && 
          chat.participants.includes(userId2)) {
        return chat;
      }
    }
    return null;
  }

  // Send a message
  async sendMessage(
    chatId: string,
    content: string,
    messageType: 'text' | 'file' | 'image' | 'audio' | 'video' = 'text',
    fileData?: string,
    fileName?: string
  ): Promise<Message> {
    const currentUser = await this.authManager.getCurrentUserSafe();
    if (!currentUser) {
      throw new Error('User not authenticated. Please log in to send messages.');
    }

    console.log('🔐 ChatManager: Sending message for user:', {
      userId: currentUser.id,
      username: currentUser.username,
      chatId
    });

    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      // Get chat
      const chat = this.chats.get(chatId);
      if (!chat) {
        throw new Error('Chat not found');
      }

      // Verify user is participant
      if (!chat.participants.includes(currentUser.id)) {
        throw new Error('User is not a participant in this chat');
      }

      // Get participant public keys for encryption
      const { data: participantProfiles } = await supabase
        .from('profiles')
        .select('id, public_key')
        .in('id', chat.participants.filter(id => id !== currentUser.id));

      const participantKeys = participantProfiles?.map(p => p.public_key) || [];

      // Encrypt message content
      const encryptedContent = this.encryptionManager.encryptMessage(
        content,
        chatId,
        participantKeys
      );

      // Handle file encryption if needed
      let encryptedFileData: string | undefined;
      let fileKey: string | undefined;

      if (fileData && messageType !== 'text') {
        const fileEncryption = this.encryptionManager.encryptFile(fileData);
        encryptedFileData = fileEncryption.encrypted;
        fileKey = fileEncryption.key;
      }

      // Create message
      const message: Message = {
        id: messageId,
        chat_id: chatId,
        sender_id: currentUser.id,
        message_type: messageType,
        file_name: fileName,
        file_size: fileData ? fileData.length : undefined,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
        content, // Store decrypted content locally for sender
      };

      // Add message to local storage
      const chatMessages = this.messages.get(chatId) || [];
      chatMessages.push(message);
      this.messages.set(chatId, chatMessages);

      // Update chat's last message
      chat.last_message = content.substring(0, 100);
      chat.last_message_at = message.created_at;
      chat.updated_at = message.created_at;
      this.chats.set(chatId, chat);

      // Save to storage
      await this.saveChatsToStorage();
      
      // Try to persist message to database (if Supabase is configured)
      try {
        const { data: inserted, error: insertError } = await supabase
          .from('messages')
          .insert({
            id: message.id,
            chat_id: message.chat_id,
            sender_id: message.sender_id,
            message_type: message.message_type,
            file_name: message.file_name || null,
            file_size: message.file_size || null,
            reply_to: message.reply_to || null,
            created_at: message.created_at,
            expires_at: message.expires_at,
            content: encryptedContent || message.content || null
          })
          .select()
          .single();

        if (insertError) {
          console.warn('Failed to persist message to DB - will retry later:', insertError.message || insertError);
          // Add to pending messages for retry
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
        } else {
          // Optionally record sender's message status as 'sent'
          try {
            const { error: statusErr } = await supabase
              .from('message_statuses')
              .upsert({
                message_id: messageId,
                user_id: currentUser.id,
                status: 'sent',
                updated_at: new Date().toISOString()
              }, { onConflict: ['message_id','user_id'] });
            if (statusErr) console.warn('Failed to set initial message status:', statusErr);
          } catch (e) {
            console.warn('Status upsert failed:', e);
          }
        }
      } catch (dbErr) {
        console.warn('Database unavailable, queued message for retry:', dbErr);
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
      }

      // Mark user active after sending
      await markActive(currentUser.id);s.saveChatsToStorage();

      // Mark user active after sending
      await markActive(currentUser.id);

      return message;
    } catch (error) {
      // Add to pending messages for retry
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

  // Update message status (delivered/seen)
  async updateMessageStatus(messageId: string, status: 'delivered' | 'seen'): Promise<void> {
    try {
      const currentUser = await this.authManager.getCurrentUserSafe();
      if (!currentUser) throw new Error('User not authenticated');

      // Upsert into message_statuses table
      const { error } = await supabase
        .from('message_statuses')
        .upsert({
          message_id: messageId,
          user_id: currentUser.id,
          status,
          updated_at: new Date().toISOString()
        }, { onConflict: ['message_id','user_id'] });

      if (error) {
        console.error('Failed to update message status in DB:', error);
        return;
      }

      // Update local cache
      for (const [chatId, msgs] of this.messages) {
        const m = msgs.find(x => x.id === messageId);
        if (m) {
          m.status = m.status || [];
          const existing = m.status.find(s => s.user_id === currentUser.id);
          if (existing) {
            existing.status = status;
            existing.updated_at = new Date().toISOString();
          } else {
            m.status.push({
              id: `local-${Math.random().toString(36).slice(2,9)}`,
              message_id: messageId,
              user_id: currentUser.id,
              status,
              updated_at: new Date().toISOString()
            });
          }
          break;
        }
      }
    } catch (err) {
      console.error('updateMessageStatus error:', err);
    }
  }

  // Get chat messages
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

  // Get user's chats
  async getUserChats(): Promise<Chat[]> {
    const currentUser = await this.authManager.getCurrentUserSafe();
    if (!currentUser) {
      console.log('🔐 ChatManager: No authenticated user for getUserChats');
      return [];
    }

    console.log('🔐 ChatManager: Getting chats for user:', {
      userId: currentUser.id,
      username: currentUser.username
    });

    try {
      // Fallback to local storage
      const userChats = Array.from(this.chats.values())
        .filter(chat => chat.participants.includes(currentUser.id))
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      
      // Get chats from database where user is a participant
      const { data: chatData, error: chatsError } = await supabase
        .from('chats')
        .select(`
          *,
          chat_participants!inner(user_id, role)
        `)
        .eq('chat_participants.user_id', currentUser.id)
        .order('updated_at', { ascending: false });

      if (chatsError) {
        console.error('Error fetching chats:', chatsError);
        // Fallback to local storage
        const userChats = Array.from(this.chats.values())
          .filter(chat => chat.participants.includes(currentUser.id))
          .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
        return userChats;
      }

      if (!chatData) return [];

      // Convert to Chat interface and get all participants for each chat
      const userChats: Chat[] = [];
      
      for (const chat of chatData) {
        // Get all participants for this chat
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
        
        // Also store locally for offline access
        this.chats.set(chat.id, chatObj);
      }

      // Save to local storage
      await this.saveChatsToStorage();

      return userChats;
    } catch (error) {
      console.error('Failed to get chats:', error);
      // Fallback to local storage
      const userChats = Array.from(this.chats.values())
        .filter(chat => chat.participants.includes(currentUser.id))
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      return userChats;
    }
  }

  // Add member to group chat
  async addGroupMember(chatId: string, userId: string): Promise<void> {
    const currentUser = await this.authManager.getCurrentUserSafe();
    if (!currentUser) {
      throw new Error('User not authenticated. Please log in to add members.');
    }

    console.log('🔐 ChatManager: Adding member to group:', {
      chatId,
      newUserId: userId,
      currentUserId: currentUser.id
    });

    try {
      const chat = this.chats.get(chatId);
      if (!chat) throw new Error('Chat not found');

      if (!chat.is_group) throw new Error('Cannot add members to direct chat');
      if (chat.created_by !== currentUser.id) throw new Error('Only chat creator can add members');

      // Verify user exists
      const { data: userProfile } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', userId)
        .single();

      if (!userProfile) throw new Error('User not found');

      // Add to participants if not already present
      if (!chat.participants.includes(userId)) {
        chat.participants.push(userId);
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
    const currentUser = await this.authManager.getCurrentUserSafe();
    if (!currentUser) {
      throw new Error('User not authenticated. Please log in to remove members.');
    }

    console.log('🔐 ChatManager: Removing member from group:', {
      chatId,
      removeUserId: userId,
      currentUserId: currentUser.id
    });

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