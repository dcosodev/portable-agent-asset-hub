# ListRetrievalEvents200ResponseItemsInner


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**classification** | **object** |  |
**counts** | **object** |  |
**created_at** | **str** |  |
**no_match** | **bool** |  |
**policy** | **object** |  |
**profile** | **str** |  |
**query_sha256** | **str** |  |
**redacted_query** | **str** |  | [optional]
**request_id** | **str** |  |

## Example

```python
from openapi_client.models.list_retrieval_events200_response_items_inner import ListRetrievalEvents200ResponseItemsInner

# TODO update the JSON string below
json = "{}"
# create an instance of ListRetrievalEvents200ResponseItemsInner from a JSON string
list_retrieval_events200_response_items_inner_instance = ListRetrievalEvents200ResponseItemsInner.from_json(json)
# print the JSON string representation of the object
print(ListRetrievalEvents200ResponseItemsInner.to_json())

# convert the object into a dict
list_retrieval_events200_response_items_inner_dict = list_retrieval_events200_response_items_inner_instance.to_dict()
# create an instance of ListRetrievalEvents200ResponseItemsInner from a dict
list_retrieval_events200_response_items_inner_from_dict = ListRetrievalEvents200ResponseItemsInner.from_dict(list_retrieval_events200_response_items_inner_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
