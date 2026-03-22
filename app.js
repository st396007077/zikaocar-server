const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const rateLimit = require('express-rate-limit'); // 新增：接口限流
const app = express();
const PORT = process.env.PORT || 3000;

// ====================== 核心配置 ======================
app.use(cors());
app.use(express.json({ limit: '50mb' })); // 支持大体积Base64数据
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 管理员接口限流：1分钟最多5次请求（防止暴力破解）
const adminLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 30, // 最多5次请求
  message: { code: -1, msg: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

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
  createTime: { type: String, required: true }, // 最后提交时间
  payScreenshots: [{ type: String }], // 存储Base64格式截图
  paymentRecords: [{
    payType: String,
    amount: Number,
    time: String
  }],
  isManuallyModified: { type: Boolean, default: false }, // 手动修改标记
  isMultiSubmit: { type: Boolean, default: false } // 多次提交标记
});

const Order = mongoose.model('Order', orderSchema);

// ====================== 数据库连接 ======================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB 连接成功'))
  .catch(err => console.error('MongoDB 连接失败:', err));

// ====================== 工具函数 ======================
// 生成唯一订单号
function generateOrderId() {
  const date = new Date();
  const dateStr = date.getFullYear().toString() + 
                  String(date.getMonth() + 1).padStart(2, '0') + 
                  String(date.getDate()).padStart(2, '0');
  const randomStr = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `SQY${dateStr}${randomStr}`;
}

// ✅ 新增：班次合并工具函数（核心修复）
// 合并新旧班次列表，保留所有班次，同名班次保留最新信息
function mergeCarLists(oldList, newList) {
  // 1. 原有班次转Map（按名称索引）
  const carMap = new Map();
  oldList.forEach(car => {
    if (car.name) {
      carMap.set(car.name, car);
    }
  });

  // 2. 新班次覆盖同名旧班次，新增班次直接添加
  newList.forEach(car => {
    if (car.name) {
      carMap.set(car.name, car);
    }
  });

  // 3. 按固定顺序排序（和前端一致）
  const FIXED_CAR_ORDER = [
    '4月11日早送','4月11日晚接','4月12日早送','4月12日晚接',
    '4月11日中午考点更换','4月12日中午考点更换'
  ];
  
  return FIXED_CAR_ORDER
    .filter(name => carMap.has(name)) // 只保留已选班次
    .map(name => carMap.get(name));   // 按固定顺序返回
}

// ====================== 核心接口 ======================
/**
 * 1. 管理员获取所有订单（POST请求，密码放请求体）
 */
app.post('/api/getAllOrders', adminLimiter, async (req, res) => {
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

/**
 * 2. 用户提交订单（核心修复：合并班次信息，不丢失历史）
 */
app.post('/api/submitOrder', async (req, res) => {
  try {
    const { userName, userPhone, total, carList, payType, createTime } = req.body;
    
    // 验证必填参数
    if (!userName || !userPhone || !total || !carList || !payType || !createTime) {
      return res.json({ code: -1, msg: '参数不全' });
    }

    // 按「姓名+电话」查找用户已有订单
    const existingOrder = await Order.findOne({
      userName,
      userPhone
    });

    if (existingOrder) {
      // 已有订单：合并数据（核心修复：班次合并）
      // ✅ 关键修改：合并新旧班次列表，不再直接覆盖
      const mergedCarList = mergeCarLists(existingOrder.carList || [], carList || []);

      existingOrder.total = total; // 更新为最新金额
      existingOrder.carList = mergedCarList; // ✅ 使用合并后的班次列表
      existingOrder.payType = payType; // 更新为最新支付方式
      existingOrder.createTime = createTime; // 更新为最后提交时间
      existingOrder.isMultiSubmit = true; // 标记为多次提交
      // 追加支付记录（保留所有提交记录）
      existingOrder.paymentRecords.push({ payType, amount: total, time: createTime });
      // 保存修改
      await existingOrder.save();
      return res.json({ code: 0, msg: '提交成功（合并到原有订单）', orderId: existingOrder.orderId });
    } else {
      // 无订单：创建新订单
      const orderId = generateOrderId();
      const newOrder = new Order({
        orderId,
        userName,
        userPhone,
        total,
        carList,
        payType,
        createTime,
        isMultiSubmit: false, // 首次提交
        payScreenshots: [],
        paymentRecords: [{ payType, amount: total, time: createTime }]
      });
      await newOrder.save();
      return res.json({ code: 0, msg: '提交成功', orderId });
    }
  } catch (err) {
    console.error('提交订单失败:', err);
    res.json({ code: -1, msg: '提交失败，请重试' });
  }
});

/**
 * 3. 上传支付截图（转Base64存储）
 */
app.post('/api/uploadScreenshot', async (req, res) => {
  try {
    const { orderId, screenshots } = req.body; // 前端传Base64数组
    
    if (!orderId || !screenshots || !Array.isArray(screenshots)) {
      return res.json({ code: -1, msg: '参数错误' });
    }

    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    // 追加Base64截图（去重）
    const uniqueScreenshots = [...new Set([...order.payScreenshots, ...screenshots])];
    order.payScreenshots = uniqueScreenshots;
    await order.save();

    res.json({ code: 0, msg: '截图上传成功' });
  } catch (err) {
    console.error('上传截图失败:', err);
    res.json({ code: -1, msg: '截图上传失败' });
  }
});

/**
 * 4. 管理员刷新订单金额
 */
app.post('/api/recalculateAmount', adminLimiter, async (req, res) => {
  try {
    const { pwd, orderId } = req.body;
    if (pwd !== process.env.ADMIN_PWD) {
      return res.json({ code: -1, msg: '密码错误' });
    }

    const order = await Order.findOne({ orderId });
    if (!order) {
      return res.json({ code: -1, msg: '订单不存在' });
    }

    // 重新计算金额
    let newTotal = 0;
    order.carList.forEach(item => {
      newTotal += Number(item.price);
    });
    order.total = newTotal;
    order.isManuallyModified = true; // 标记为手动修改
    await order.save();

    res.json({ code: 0, msg: `金额刷新成功，新金额：${newTotal}元` });
  } catch (err) {
    console.error('刷新金额失败:', err);
    res.json({ code: -1, msg: '刷新金额失败' });
  }
});

/**
 * 5. 管理员删除订单
 */
app.post('/api/deleteOrder', adminLimiter, async (req, res) => {
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
    res.json({ code: -1, msg: '删除订单失败' });
  }
});

/**
 * 6. 用户查询订单
 */
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

// ====================== 启动服务 ======================
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
