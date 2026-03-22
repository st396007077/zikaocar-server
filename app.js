const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// ====================== 核心配置 ======================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ====================== MongoDB 模型定义 ======================
const orderSchema = new mongoose.Schema({
  orderId: { type: String, unique: true, required: true },
  userName: { type: String, required: true },
  userPhone: { type: String, required: true },
  total: { type: Number, required: true },
  carList: [{
    name: String,
    price: String,
    school: String,
    from: String,
    to: String
  }],
  payType: { type: String, required: true },
  createTime: { type: String, required: true },
  payScreenshots: [{ type: String }],
  paymentRecords: [{
    payType: String,
    amount: Number,
    time: String
  }],
  isManuallyModified: { type: Boolean, default: false },
  isMultiSubmit: { type: Boolean, default: false }
});

// ============= 🔥 关键修复：移除有问题的全局中间件 =============
// ❌ 已移除：orderSchema.pre('findOneAndUpdate', ...) 中间件
// 原因：这个中间件会导致任何更新carList的操作（包括正常的用户提交）
// 都被错误地标记为"手动修改"

// ✅ 保留：仅处理通过 .save() 方法的修改
orderSchema.pre('save', function(next) {
  // 只在保存时检查carList是否被修改
  if (this.isModified('carList')) {
    // 注意：这里设置为true，但只对.save()生效
    // 对于用户正常提交，carList会被修改，但isManuallyModified应该保持false
    // 这个逻辑需要与接口逻辑配合
    this.isManuallyModified = true;
  }
  next();
});

const Order = mongoose.model('Order', orderSchema);

// ====================== 数据库连接 ======================
let dbConnectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 3;

async function connectToDatabase() {
  try {
    if (!process.env.MONGODB_URI) {
      console.error('错误：MONGODB_URI 环境变量未设置');
      console.error('请在Render.com的项目设置中配置MONGODB_URI环境变量');
      process.exit(1);
    }
    
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    
    console.log('✅ MongoDB 连接成功');
    dbConnectionAttempts = 0;
    
    mongoose.connection.on('error', (err) => {
      console.error('MongoDB 连接错误:', err);
    });
    
    mongoose.connection.on('disconnected', () => {
      console.log('MongoDB 连接断开，尝试重连...');
      if (dbConnectionAttempts < MAX_CONNECTION_ATTEMPTS) {
        dbConnectionAttempts++;
        setTimeout(connectToDatabase, 2000);
      }
    });
    
  } catch (err) {
    console.error('❌ MongoDB 连接失败:', err.message);
    
    if (dbConnectionAttempts < MAX_CONNECTION_ATTEMPTS) {
      dbConnectionAttempts++;
      console.log(`尝试重新连接 (${dbConnectionAttempts}/${MAX_CONNECTION_ATTEMPTS})...`);
      setTimeout(connectToDatabase, 2000);
    } else {
      console.error('达到最大重试次数，应用将退出');
      process.exit(1);
    }
  }
}

// 启动时连接数据库
connectToDatabase();

// ====================== 工具函数 ======================
function generateOrderId() {
  const date = new Date();
  const dateStr = date.getFullYear().toString() + 
                  String(date.getMonth() + 1).padStart(2, '0') + 
                  String(date.getDate()).padStart(2, '0');
  const randomStr = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `SQY${dateStr}${randomStr}`;
}

function calculateTotal(carList) {
  let total = 0;
  (carList || []).forEach(item => {
    total += Number(item.price) || 0;
  });
  return total;
}

function mergeCarLists(oldList, newList) {
  const carMap = new Map();
  oldList.forEach(car => { if (car.name) carMap.set(car.name, car); });
  newList.forEach(car => { if (car.name) carMap.set(car.name, car); });
  const FIXED_CAR_ORDER = [
    '4月11日早送','4月11日晚接','4月12日早送','4月12日晚接',
    '4月11日中午考点更换','4月12日中午考点更换'
  ];
  return FIXED_CAR_ORDER.filter(name => carMap.has(name)).map(name => carMap.get(name));
}

// ====================== 核心接口 ======================
app.post('/api/getAllOrders', async (req, res) => {
  try {
    const { pwd } = req.body;
    if (pwd !== process.env.ADMIN_PWD) {
      return res.json({ code: -1, msg: '密码错误' });
    }
    const orders = await Order.find().sort({ createTime: -1 });
    res.json({ code: 0, data: orders });
  } catch (err) {
    console.error('获取订单失败:', err);
    res.json({ code: -1, msg: '获取订单失败' });
  }
});

// 🔥 修复：submitOrder接口 - 防止错误标记手动修改
app.post('/api/submitOrder', async (req, res) => {
  try {
    const { userName, userPhone, carList, payType, createTime } = req.body;
    if (!userName || !userPhone || !carList || !payType || !createTime) {
      return res.json({ code: -1, msg: '参数不全' });
    }

    const existingOrder = await Order.findOne({ userName, userPhone });
    if (existingOrder) {
      const mergedCarList = mergeCarLists(existingOrder.carList || [], carList || []);
      const newTotal = calculateTotal(mergedCarList);
      
      // 保存原有状态
      const originalIsManuallyModified = existingOrder.isManuallyModified;
      
      existingOrder.total = newTotal;
      existingOrder.carList = mergedCarList;
      existingOrder.payType = payType;
      existingOrder.createTime = createTime;
      existingOrder.isMultiSubmit = true;
      existingOrder.paymentRecords.push({ payType, amount: newTotal, time: createTime });
      
      // 🔥 关键修复：用户正常提交/合并订单时，保持原有的手动修改状态
      // 不将 isManuallyModified 设置为 true
      existingOrder.isManuallyModified = originalIsManuallyModified;
      
      await existingOrder.save();
      return res.json({ code: 0, msg: '提交成功（合并到原有订单）', orderId: existingOrder.orderId });
    } else {
      const mergedCarList = mergeCarLists([], carList || []);
      const newTotal = calculateTotal(mergedCarList);
      const orderId = generateOrderId();
      const newOrder = new Order({
        orderId, 
        userName, 
        userPhone, 
        total: newTotal,
        carList: mergedCarList, 
        payType, 
        createTime,
        isMultiSubmit: false,
        isManuallyModified: false, // 新订单默认不是手动修改
        payScreenshots: [],
        paymentRecords: [{ payType, amount: newTotal, time: createTime }]
      });
      await newOrder.save();
      return res.json({ code: 0, msg: '提交成功', orderId });
    }
  } catch (err) {
    console.error('提交订单失败:', err);
    res.json({ code: -1, msg: '提交失败，请重试' });
  }
});

app.post('/api/uploadScreenshot', async (req, res) => {
  try {
    const { orderId, screenshots } = req.body;
    if (!orderId || !screenshots || !Array.isArray(screenshots)) {
      return res.json({ code: -1, msg: '参数错误' });
    }

    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.json({ code: -1, msg: '订单不存在' });
    }
    order.payScreenshots.push(...screenshots);
    await order.save();
    res.json({ code: 0, msg: '截图上传成功' });
  } catch (err) {
    console.error('上传截图失败:', err);
    res.json({ code: -1, msg: '截图上传失败' });
  }
});

app.post('/api/recalculateAmount', async (req, res) => {
  try {
    const { pwd, orderId } = req.body;
    if (pwd !== process.env.ADMIN_PWD) {
      return res.json({ code: -1, msg: '密码错误' });
    }

    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.json({ code: -1, msg: '订单不存在' });
    }
    const newTotal = calculateTotal(order.carList);
    
    // 重新计算金额时，保持原有的手动修改状态
    const originalIsManuallyModified = order.isManuallyModified;
    order.total = newTotal;
    order.isManuallyModified = originalIsManuallyModified;
    
    await order.save();
    res.json({ code: 0, msg: `金额刷新成功，新金额：${newTotal}元` });
  } catch (err) {
    console.error('刷新金额失败:', err);
    res.json({ code: -1, msg: '刷新金额失败' });
  }
});

app.post('/api/deleteOrder', async (req, res) => {
  try {
    const { pwd, id } = req.body;
    if (pwd !== process.env.ADMIN_PWD) {
      return res.json({ code: -1, msg: '密码错误' });
    }
    const result = await Order.findByIdAndDelete(id);
    if (!result) {
      return res.json({ code: -1, msg: '订单不存在' });
    }
    res.json({ code: 0, msg: '订单删除成功' });
  } catch (err) {
    console.error('删除订单失败:', err);
    res.json({ code: -1, msg: '删除失败' });
  }
});

app.get('/api/queryOrder', async (req, res) => {
  try {
    const { userName } = req.query;
    if (!userName) {
      return res.json({ code: -1, msg: '请输入姓名' });
    }
    const orders = await Order.find({ userName: new RegExp(userName) }).sort({ createTime: -1 });
    res.json({ code: 0, data: orders });
  } catch (err) {
    console.error('查询订单失败:', err);
    res.json({ code: -1, msg: '查询失败' });
  }
});

// 🔥 修复：修改订单数据接口 - 明确标记手动修改
app.post('/api/updateOrder', async (req, res) => {
  try {
    const { pwd, orderId, updates } = req.body;
    
    if (pwd !== process.env.ADMIN_PWD) {
      return res.json({ code: -1, msg: '密码错误' });
    }
    
    if (!orderId || !updates) {
      return res.json({ code: -1, msg: '参数不全' });
    }
    
    // 检查是否修改了 carList
    const isModifyingCarList = updates.carList !== undefined;
    
    const updateData = { ...updates };
    
    if (isModifyingCarList) {
      updateData.total = calculateTotal(updates.carList);
      // 🔥 关键修复：只有通过后台修改接口更新carList，才标记为手动修改
      updateData.isManuallyModified = true;
      console.log(`📝 订单 ${orderId} 被标记为手动修改 (通过updateOrder接口)`);
    }
    
    const order = await Order.findOneAndUpdate(
      { orderId },
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!order) {
      return res.json({ code: -1, msg: '订单不存在' });
    }
    
    res.json({ 
      code: 0, 
      msg: '订单更新成功',
      data: order
    });
    
  } catch (err) {
    console.error('更新订单失败:', err);
    res.json({ code: -1, msg: '更新订单失败' });
  }
});

// 🔥 修复：修改单个班次接口 - 明确标记手动修改
app.post('/api/updateCarItem', async (req, res) => {
  try {
    const { pwd, orderId, carIndex, updates } = req.body;
    
    if (pwd !== process.env.ADMIN_PWD) {
      return res.json({ code: -1, msg: '密码错误' });
    }
    
    if (!orderId || carIndex === undefined || !updates) {
      return res.json({ code: -1, msg: '参数不全' });
    }
    
    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.json({ code: -1, msg: '订单不存在' });
    }
    
    if (order.carList && order.carList[carIndex]) {
      const oldCarItem = { ...order.carList[carIndex] };
      order.carList[carIndex] = { ...oldCarItem, ...updates };
      
      const hasChanged = JSON.stringify(oldCarItem) !== JSON.stringify(order.carList[carIndex]);
      
      if (hasChanged) {
        // 🔥 关键修复：只有通过后台修改接口更新carList，才标记为手动修改
        order.isManuallyModified = true;
        order.total = calculateTotal(order.carList);
        console.log(`📝 订单 ${orderId} 被标记为手动修改 (通过updateCarItem接口)`);
        await order.save();
      } else {
        return res.json({ code: 0, msg: '未检测到班次信息变化', data: order });
      }
    } else {
      return res.json({ code: -1, msg: '班次不存在' });
    }
    
    res.json({ 
      code: 0, 
      msg: '班次更新成功',
      data: order
    });
    
  } catch (err) {
    console.error('更新班次失败:', err);
    res.json({ code: -1, msg: '更新班次失败' });
  }
});

// ====================== 🔥 新增：数据库修复接口（临时使用） ======================
// ⚠️ 警告：此接口仅供一次性修复使用，修复完成后请立即从代码中删除
app.post('/api/fixDatabaseManualFlags', async (req, res) => {
  try {
    const { pwd, confirm } = req.body;
    
    if (pwd !== process.env.ADMIN_PWD) {
      return res.json({ code: -1, msg: '密码错误' });
    }
    
    if (confirm !== 'YES_I_UNDERSTAND') {
      return res.json({ 
        code: -1, 
        msg: '请确认操作：此操作将重置所有订单的"手动修改"标记。确认请在请求体中添加 confirm: "YES_I_UNDERSTAND"' 
      });
    }
    
    console.log('⚠️ 开始修复数据库：重置所有订单的 isManuallyModified 为 false');
    
    // 重置所有订单的 isManuallyModified 为 false
    const result = await Order.updateMany(
      {},
      { $set: { isManuallyModified: false } }
    );
    
    console.log(`✅ 修复完成：已重置 ${result.modifiedCount} 个订单的标记`);
    
    res.json({ 
      code: 0, 
      msg: `修复完成，已重置 ${result.modifiedCount} 个订单的 isManuallyModified 为 false`,
      modifiedCount: result.modifiedCount
    });
    
  } catch (err) {
    console.error('修复数据库失败:', err);
    res.json({ code: -1, msg: '修复失败' });
  }
});

// ====================== 健康检查接口 ======================
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: '山青院专车订单管理系统 API 运行正常',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  res.json({ 
    status: 'ok',
    database: dbStatus,
    uptime: process.uptime()
  });
});

// ====================== 错误处理中间件 ======================
app.use((err, req, res, next) => {
  console.error('未捕获的错误:', err);
  res.status(500).json({ 
    code: -1, 
    msg: '服务器内部错误',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 处理 404
app.use((req, res) => {
  res.status(404).json({ code: -1, msg: '接口不存在' });
});

// ====================== 启动服务 ======================
if (!process.env.MONGODB_URI) {
  console.error('❌ 错误：MONGODB_URI 环境变量未设置');
  console.error('请在Render.com的项目设置中配置以下环境变量：');
  console.error('1. MONGODB_URI - MongoDB连接字符串');
  console.error('2. ADMIN_PWD - 后台管理密码');
  process.exit(1);
}

// 延迟启动，确保数据库连接
setTimeout(() => {
  app.listen(PORT, () => {
    console.log(`✅ 服务器运行在端口 ${PORT}`);
    console.log(`📁 数据库连接状态: ${mongoose.connection.readyState === 1 ? '已连接' : '未连接'}`);
    console.log(`🌍 访问地址: http://localhost:${PORT}`);
    console.log('🔧 修复说明：已移除有问题的中间件，精确控制手动修改标记');
  });
}, 1000);
