export default async function(context , MyQueueItem){
    context.log(" service bus triggered fucntion is receiving messages" , MyQueueItem)
    try{
        const data = typeof MyQueueItem == "string" ? JSON.parse(MyQueueItem) : MyQueueItem;
        context.log("parsed messages" , data)
         if(data.user && data.task){
        context.log(`succcessfully recieved ${data.user} and ${data.task}`)
    }
    }catch(e){
        context.log("Error parsing messages:" , e)
    }
   

}