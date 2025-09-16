import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Alert,
} from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/contexts/AuthContext';
import { MessageCircle, Users, Plus, Search } from 'lucide-react-native';
import { ChatManager, Chat } from '@/lib/chat';

export default function HomeScreen() {
  const { user } = useAuth();
  const [chats, setChats] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(true);
  const chatManager = ChatManager.getInstance();

  // Always call hooks – never return before them
  useEffect(() => {
    if (user) {
      loadChats();
    } else {
      setLoading(false); // stop loading if no user
    }
  }, [user]);

  const loadChats = async () => {
    try {
      const userChats = await chatManager.getUserChats();
      setChats(userChats);
    } catch (error) {
      console.error('Failed to load chats:', error);
      if (error instanceof Error && error.message.includes('session')) {
        // Delay navigation until after mount
        setTimeout(() => {
          router.push('/(auth)/welcome');
        }, 0);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCreateChat = () => {
    Alert.alert('New Chat', 'Choose chat type', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Direct Message', onPress: () => router.push('/(tabs)/contacts') },
      { text: 'Group Chat', onPress: () => console.log('Create group') },
    ]);
  };

  const renderChatItem = ({ item }: { item: Chat }) => (
    <TouchableOpacity
      style={styles.chatItem}
      onPress={() => console.log('Open chat:', item.id)}
    >
      <View style={styles.chatAvatar}>
        <Text style={styles.chatInitial}>
          {item.name ? item.name.charAt(0).toUpperCase() : 'C'}
        </Text>
      </View>

      <View style={styles.chatInfo}>
        <Text style={styles.chatName}>
          {item.name || `Chat ${item.id.slice(0, 8)}`}
        </Text>
        <Text style={styles.chatPreview}>
          {item.is_group ? 'Group Chat' : 'Direct Message'}
        </Text>
        <Text style={styles.chatTime}>
          {new Date(item.updated_at).toLocaleDateString()}
        </Text>
      </View>

      <View style={styles.chatMeta}>
        {item.is_group && (
          <View style={styles.groupBadge}>
            <Users size={12} color="#666" />
          </View>
        )}
      </View>
    </TouchableOpacity>
  );

  // Conditional rendering happens here, not before hooks
  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Loading chats...</Text>
      </View>
    );
  }

  if (!user) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Please log in to continue</Text>
        <TouchableOpacity
          style={styles.loginButton}
          onPress={() => router.push('/(auth)/welcome')}
        >
          <Text style={styles.loginButtonText}>Go to Login</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (chats.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <MessageCircle size={80} color="#ddd" />
        <Text style={styles.emptyTitle}>No chats yet</Text>
        <Text style={styles.emptyText}>
          Start a conversation by finding contacts or creating a group
        </Text>
        <TouchableOpacity
          style={styles.startChatButton}
          onPress={() => router.push('/(tabs)/contacts')}
        >
          <Text style={styles.startChatButtonText}>Find Contacts</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Chats</Text>
          <Text style={styles.headerSubtitle}>End-to-end encrypted</Text>
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={() => router.push('/(tabs)/contacts')}
          >
            <Search size={24} color="#2563eb" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={handleCreateChat}
          >
            <Plus size={24} color="#2563eb" />
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={chats}
        renderItem={renderChatItem}
        keyExtractor={(item) => item.id}
        style={styles.chatsList}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
  },
  loadingText: {
    fontSize: 16,
    color: '#64748b',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 20,
    backgroundColor: '#fff',
    borderBottomWidth: 0.5,
    borderBottomColor: '#e2e8f0',
  },
  headerLeft: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#1e293b',
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 13,
    color: '#64748b',
  },
  headerRight: {
    flexDirection: 'row',
    gap: 8,
  },
  headerButton: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
  },
  chatsList: {
    flex: 1,
  },
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 0.5,
    borderBottomColor: '#f1f5f9',
  },
  chatAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#2563eb',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  chatInitial: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#fff',
  },
  chatInfo: {
    flex: 1,
  },
  chatName: {
    fontSize: 17,
    fontWeight: '600',
    color: '#1e293b',
    marginBottom: 4,
  },
  chatPreview: {
    fontSize: 14,
    color: '#64748b',
    marginBottom: 2,
  },
  chatTime: {
    fontSize: 12,
    color: '#94a3b8',
  },
  chatMeta: {
    alignItems: 'center',
    gap: 4,
  },
  groupBadge: {
    padding: 4,
    borderRadius: 4,
    backgroundColor: '#f1f5f9',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 24,
    fontWeight: '600',
    color: '#475569',
    marginTop: 24,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 16,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
  },
  startChatButton: {
    backgroundColor: '#2563eb',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
  },
  startChatButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  loginButton: {
    backgroundColor: '#2563eb',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    marginTop: 16,
  },
  loginButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});