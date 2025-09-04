import ServiceBusClient from '@azure/service-bus'



export default async function (context, req) {
    const connectionString = process.env.SERVICEBUS_CONNECTION;
    const queueName = process.env.QUEUE_NAME;
  try {
    const messageBody = req.body;

    if (!messageBody) {
      context.res = {
        status: 400,
        body: "Request body is required",
      };
      return;
    }

    // Create Service Bus client + sender
    const sbClient = new ServiceBusClient(connectionString);
    const sender = sbClient.createSender(queueName);

    // Send the message
    await sender.sendMessages({ body: messageBody });

    // Close connections
    await sender.close();
    await sbClient.close();

    context.log(`Message sent to queue: ${JSON.stringify(messageBody)}`);

    context.res = {
      status: 200,
      body: { success: true, sentData: messageBody },
    };
  } catch (err) {
    context.log.error("Error sending message:", err);
    context.res = {
      status: 500,
      body: { error: err.message },
    };
  }
};
