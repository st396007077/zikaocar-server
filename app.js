function exportExcel() {
  if(!filteredOrderData.length) { showModal('提示','暂无数据'); return; }

  const excelData = filteredOrderData.map(o => {
    const getInfo = (n) => {
      const i = o.carList.find(x => x.name === n);
      if(!i) return '-';
      if(i.school) return i.school;
      if(i.from && i.to) return i.from+'→'+i.to;
      return '-';
    };

    const payRecords = o.paymentRecords?.length
      ? o.paymentRecords.map((r,i)=>`第${i+1}笔：${r.payType} ${r.amount}元 ${r.time}`).join('\n')
      : '-';

    // ✅ 安全导出：只显示数量，不导出长字符串
    const screenshotText = o.payScreenshots?.length
      ? `共${o.payScreenshots.length}张`
      : "无截图";

    return {
      '订单ID': o.orderId,
      '姓名': o.userName,
      '电话': o.userPhone,
      '支付方式': o.payType,
      '支付记录': payRecords,
      '付款截图': screenshotText,  // ✅ 安全
      '总金额': o.total+'元',
      '提交时间': o.createTime,
      '4月11日早送': getInfo('4月11日早送'),
      '4月11日晚接': getInfo('4月11日晚接'),
      '4月12日早送': getInfo('4月12日早送'),
      '4月12日晚接': getInfo('4月12日晚接'),
      '4月11日中午': getInfo('4月11日中午考点更换'),
      '4月12日中午': getInfo('4月12日中午考点更换')
    };
  });

  const ws = XLSX.utils.json_to_sheet(excelData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '订单');
  XLSX.writeFile(wb, `订单_${new Date().toLocaleDateString()}.xlsx`);
  showModal('成功','导出完成！');
}
