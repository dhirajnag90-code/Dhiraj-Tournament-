require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const crypto = require('crypto');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}

const db = admin.firestore();
const app = express();

app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized: No token provided' });

    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

const adminMiddleware = async (req, res, next) => {
  try {
    if (!req.user || !req.user.admin) {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Forbidden' });
  }
};

const generateReferralCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

app.post('/auth/signup', authMiddleware, async (req, res) => {
  try {
    const { username, email, referralCode } = req.body;
    const uid = req.user.uid;
    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) {
        const newUser = {
          username: username || '',
          email: email || req.user.email || '',
          wallet: 0,
          totalXP: 0,
          joinedMatches: [],
          referralCode: generateReferralCode(),
          referredBy: referralCode || null,
          matchesPlayed: 0,
          totalKills: 0,
          dailyStreak: 0,
          isVIP: false,
          lastDailyReward: 0,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        t.set(userRef, newUser);
      }
    });

    return res.status(200).json({ success: true, message: 'User created or already exists' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/wallet/createOrder', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
    const uid = req.user.uid;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const orderId = `ORDER_${crypto.randomBytes(8).toString('hex')}`;
    const cashfreeEndpoint = process.env.CASHFREE_API_URL || 'https://sandbox.cashfree.com/pg/orders';

    const response = await fetch(cashfreeEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': process.env.CASHFREE_APP_ID,
        'x-client-secret': process.env.CASHFREE_SECRET_KEY,
        'x-api-version': '2022-09-01'
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: amount,
        order_currency: 'INR',
        customer_details: {
          customer_id: uid,
          customer_phone: '9999999999',
          customer_email: req.user.email || 'user@example.com'
        },
        order_meta: {
          return_url: `${process.env.FRONTEND_URL}/payment-return?order_id={order_id}`
        }
      })
    });

    const cashfreeData = await response.json();

    if (!response.ok) {
      return res.status(400).json({ error: 'Failed to create Cashfree order', details: cashfreeData });
    }

    const txRef = db.collection('transactions').doc(orderId);
    await txRef.set({
      userId: uid,
      type: 'DEPOSIT',
      amount: Number(amount),
      status: 'PENDING',
      orderId: orderId,
      paymentSessionId: cashfreeData.payment_session_id,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.status(200).json({
      orderId,
      paymentSessionId: cashfreeData.payment_session_id
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/webhook/cashfree', async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const rawBody = req.rawBody.toString('utf8');

    const expectedSignature = crypto
      .createHmac('sha256', process.env.CASHFREE_SECRET_KEY)
      .update(timestamp + rawBody)
      .digest('base64');

    if (signature !== expectedSignature) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const payload = JSON.parse(rawBody);
    const orderId = payload.data.order.order_id;
    const paymentStatus = payload.data.payment.payment_status;
    const amount = Number(payload.data.order.order_amount);

    const txRef = db.collection('transactions').doc(orderId);

    await db.runTransaction(async (t) => {
      const txDoc = await t.get(txRef);
      if (!txDoc.exists) return;

      const txData = txDoc.data();
      if (txData.status !== 'PENDING') return; 

      if (paymentStatus === 'SUCCESS') {
        const userRef = db.collection('users').doc(txData.userId);
        
        t.update(txRef, { status: 'SUCCESS', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        t.update(userRef, { wallet: admin.firestore.FieldValue.increment(amount) });
      } else if (paymentStatus === 'FAILED' || paymentStatus === 'USER_DROPPED') {
        t.update(txRef, { status: 'FAILED', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    });

    return res.status(200).send('OK');
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/match/join', authMiddleware, async (req, res) => {
  try {
    const { matchId, gameUids } = req.body;
    const uid = req.user.uid;

    if (!matchId || !Array.isArray(gameUids) || gameUids.length === 0 || gameUids.length > 4) {
      return res.status(400).json({ error: 'Invalid join parameters' });
    }

    const matchRef = db.collection('matches').doc(matchId);
    const userRef = db.collection('users').doc(uid);
    const teamRef = matchRef.collection('teams').doc(uid);

    await db.runTransaction(async (t) => {
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error('Match not found');

      const matchData = matchDoc.data();
      if (matchData.status !== 'upcoming') throw new Error('Match is not upcoming');
      if (matchData.joinedCount >= matchData.maxPlayers) throw new Error('Match is full');

      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');
      
      const userData = userDoc.data();
      if (userData.wallet < matchData.entryFee) throw new Error('Insufficient wallet balance');

      const teamDoc = await t.get(teamRef);
      if (teamDoc.exists) throw new Error('User has already joined this match');

      const teamsSnapshot = await t.get(matchRef.collection('teams'));
      const allGameUids = new Set();
      teamsSnapshot.forEach(doc => {
        const data = doc.data();
        (data.gameUids || []).forEach(id => allGameUids.add(id));
      });

      for (let gUid of gameUids) {
        if (allGameUids.has(gUid)) throw new Error(`Duplicate gameUid detected: ${gUid}`);
      }

      t.set(teamRef, {
        ownerUid: uid,
        ownerUsername: userData.username,
        gameUids: gameUids,
        joinedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      t.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(-matchData.entryFee),
        joinedMatches: admin.firestore.FieldValue.arrayUnion(matchId)
      });

      t.update(matchRef, {
        joinedCount: admin.firestore.FieldValue.increment(1)
      });

      const txRef = db.collection('transactions').doc();
      t.set(txRef, {
        userId: uid,
        type: 'MATCH_FEE',
        amount: -matchData.entryFee,
        matchId: matchId,
        status: 'SUCCESS',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.status(200).json({ success: true, message: 'Joined match successfully' });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/rewards/daily', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.uid;
    const userRef = db.collection('users').doc(uid);
    const DAILY_REWARD_AMOUNT = 10; 
    const COOLDOWN_MS = 24 * 60 * 60 * 1000; 

    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (!userDoc.exists) throw new Error('User not found');

      const userData = userDoc.data();
      const lastReward = userData.lastDailyReward || 0;
      const now = Date.now();

      if (now - lastReward < COOLDOWN_MS) {
        throw new Error('Daily reward already claimed. Please wait 24 hours.');
      }

      t.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(DAILY_REWARD_AMOUNT),
        dailyStreak: admin.firestore.FieldValue.increment(1),
        lastDailyReward: now
      });

      const txRef = db.collection('transactions').doc();
      t.set(txRef, {
        userId: uid,
        type: 'DAILY_REWARD',
        amount: DAILY_REWARD_AMOUNT,
        status: 'SUCCESS',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.status(200).json({ success: true, message: 'Daily reward claimed' });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/wallet/withdraw', authMiddleware, async (req, res) => {
  try {
    const { amount, upiId } = req.body;
    const uid = req.user.uid;

    if (!amount || amount <= 0 || !upiId) {
      return res.status(400).json({ error: 'Invalid amount or UPI ID' });
    }

    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      const userData = userDoc.data();

      if (userData.wallet < amount) {
        throw new Error('Insufficient wallet balance');
      }

      t.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(-amount)
      });

      const txRef = db.collection('transactions').doc();
      t.set(txRef, {
        userId: uid,
        type: 'WITHDRAWAL',
        amount: -amount,
        upiId: upiId,
        status: 'PENDING',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.status(200).json({ success: true, message: 'Withdrawal request submitted successfully' });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/admin/match/distribute', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { matchId, gameUid, rank, kills } = req.body;

    if (!matchId || !gameUid || rank === undefined || kills === undefined) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const matchRef = db.collection('matches').doc(matchId);
    const distributionRef = matchRef.collection('distributions').doc(gameUid);

    await db.runTransaction(async (t) => {
      const matchDoc = await t.get(matchRef);
      if (!matchDoc.exists) throw new Error('Match not found');
      
      const matchData = matchDoc.data();
      if (matchData.prizeDistributed) throw new Error('Match prizes already fully distributed globally');

      const distributionDoc = await t.get(distributionRef);
      if (distributionDoc.exists) throw new Error('Prize already distributed for this gameUid');

      const teamsQuery = await t.get(matchRef.collection('teams').where('gameUids', 'array-contains', gameUid));
      if (teamsQuery.empty) throw new Error('Player not found in any team for this match');

      const teamDoc = teamsQuery.docs[0];
      const teamData = teamDoc.data();
      const ownerUid = teamData.ownerUid;

      const perKillRate = matchData.perKillRate || 0;
      const rankPrizes = matchData.rankPrizes || {};
      const rankPrize = rankPrizes[String(rank)] || 0;
      
      const totalPrize = (Number(kills) * Number(perKillRate)) + Number(rankPrize);
      const xpGained = (Number(kills) * 10) + Math.max(0, (100 - (rank * 5))); 

      const userRef = db.collection('users').doc(ownerUid);

      if (totalPrize > 0 || xpGained > 0) {
        t.update(userRef, {
          wallet: admin.firestore.FieldValue.increment(totalPrize),
          totalXP: admin.firestore.FieldValue.increment(xpGained),
          matchesPlayed: admin.firestore.FieldValue.increment(1),
          totalKills: admin.firestore.FieldValue.increment(kills)
        });
      }

      if (totalPrize > 0) {
        const txRef = db.collection('transactions').doc();
        t.set(txRef, {
          userId: ownerUid,
          type: 'PRIZE_WINNING',
          amount: totalPrize,
          matchId: matchId,
          gameUid: gameUid,
          status: 'SUCCESS',
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      t.set(distributionRef, {
        gameUid: gameUid,
        rank: rank,
        kills: kills,
        prize: totalPrize,
        xp: xpGained,
        distributedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.status(200).json({ success: true, message: 'Prize distributed successfully' });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
      
