# ListRetrievalEvents200Response


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**items** | [**List[ListRetrievalEvents200ResponseItemsInner]**](ListRetrievalEvents200ResponseItemsInner.md) |  |

## Example

```python
from openapi_client.models.list_retrieval_events200_response import ListRetrievalEvents200Response

# TODO update the JSON string below
json = "{}"
# create an instance of ListRetrievalEvents200Response from a JSON string
list_retrieval_events200_response_instance = ListRetrievalEvents200Response.from_json(json)
# print the JSON string representation of the object
print(ListRetrievalEvents200Response.to_json())

# convert the object into a dict
list_retrieval_events200_response_dict = list_retrieval_events200_response_instance.to_dict()
# create an instance of ListRetrievalEvents200Response from a dict
list_retrieval_events200_response_from_dict = ListRetrievalEvents200Response.from_dict(list_retrieval_events200_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
